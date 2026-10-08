import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FailureClass } from "@irs/domain";
import * as publicApi from "./index.js";
import type {
  AdapterFailure,
  AdapterRequestContext,
  AdapterResult,
  CreateCustomerCapability,
  CreateFulfillmentOrderInput,
  CreateOrderCapability,
  Customer,
  GetCustomerCapability,
  GetOrderCapability,
  ListCustomersCapability,
  LookupTransactionCapability,
  SendNotificationCapability,
  UpdateCustomerCapability,
  UpdateOrderCapability,
} from "./index.js";

// ---------------------------------------------------------------------
// Type-level assertions. These are enforced by `tsc` (the test script
// compiles before running), so a violation fails the build, not just a
// test. Every `@ts-expect-error` also fails if the error it expects
// ever stops occurring, so these checks cannot silently go stale.
// ---------------------------------------------------------------------
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type Expect<T extends true> = T;

// The failure boundary uses @irs/domain's FailureClass exactly (no copy).
type _failureClassIsCanonical = Expect<
  Equal<AdapterFailure["failureClass"], FailureClass>
>;
// A failure identifies and carries normalized transport metadata. It
// does not decide recovery, and carries no vendor-specific fields.
type _failureShape = Expect<
  Equal<
    keyof AdapterFailure,
    "failureClass" | "message" | "httpStatus" | "retryAfterMs"
  >
>;
// Transport metadata is optional (not every mechanism is HTTP).
type _httpStatusIsOptional = Expect<
  Equal<AdapterFailure["httpStatus"], number | undefined>
>;
type _retryAfterIsOptional = Expect<
  Equal<AdapterFailure["retryAfterMs"], number | undefined>
>;

// Each capability promises exactly one operation, nothing bundled.
type _c1 = Expect<Equal<keyof CreateCustomerCapability, "createCustomer">>;
type _c2 = Expect<Equal<keyof GetCustomerCapability, "getCustomer">>;
type _c3 = Expect<Equal<keyof UpdateCustomerCapability, "updateCustomer">>;
type _c4 = Expect<Equal<keyof ListCustomersCapability, "listCustomers">>;
// Payment is lookup only: no emit / normalize / verify method.
type _p1 = Expect<Equal<keyof LookupTransactionCapability, "lookupTransaction">>;
type _f1 = Expect<Equal<keyof CreateOrderCapability, "createOrder">>;
type _f2 = Expect<Equal<keyof GetOrderCapability, "getOrder">>;
type _f3 = Expect<Equal<keyof UpdateOrderCapability, "updateOrder">>;
type _n1 = Expect<Equal<keyof SendNotificationCapability, "sendNotification">>;

// @ts-expect-error — there is deliberately no universal adapter interface
import type { IntegrationAdapter } from "./index.js";
// @ts-expect-error — Task 009 defines no PaymentEvent; inbound payment-event contracts are decided with Task 010
import type { PaymentEvent } from "./index.js";

// @ts-expect-error — failureClass is required
const _missingClass: AdapterFailure = { message: "x" };
// @ts-expect-error — only canonical FailureClass values are accepted
const _badClass: AdapterFailure = { failureClass: "NOT_A_CLASS", message: "x" };
const _recovery: AdapterFailure = {
  failureClass: FailureClass.TRANSIENT,
  message: "x",
  // @ts-expect-error — adapters identify failures; they do not carry RecoveryAction
  recoveryAction: "RETRY",
};
const _vendorCode: AdapterFailure = {
  failureClass: FailureClass.TRANSIENT,
  message: "x",
  // @ts-expect-error — no vendor error code on the boundary (deferred to a later task)
  errorCode: "VENDOR_123",
};
const _rawBody: AdapterFailure = {
  failureClass: FailureClass.TRANSIENT,
  message: "x",
  // @ts-expect-error — raw response bodies never cross the boundary
  responseBody: "<html>",
};
// @ts-expect-error — `failure` is only reachable after narrowing on `ok`
const _unnarrowed = (r: AdapterResult<Customer>) => r.failure;

// A provider supporting only reads is NOT thereby a CreateCustomerCapability.
const readOnlyCrm: GetCustomerCapability & ListCustomersCapability = {
  async getCustomer(id) {
    return { ok: true, value: { id, name: "Ada" } };
  },
  async listCustomers() {
    return { ok: true, value: [] };
  },
};
// @ts-expect-error — supporting read capabilities does not imply write capabilities
const _notACreator: CreateCustomerCapability = readOnlyCrm;

// ---------------------------------------------------------------------
// Runtime tests (only where there is runtime behavior to check).
// ---------------------------------------------------------------------
describe("@irs/integrations public entry point", () => {
  it("is types only: exports nothing at runtime (no factory, registry, base class, or framework)", () => {
    assert.deepEqual(Object.keys(publicApi), []);
  });
});

describe("failure boundary", () => {
  it("can carry every canonical FailureClass from @irs/domain", () => {
    for (const failureClass of Object.values(FailureClass)) {
      const failure: AdapterFailure = {
        failureClass,
        message: `provider failure (${failureClass})`,
      };
      assert.equal(failure.failureClass, failureClass);
    }
  });

  it("represents success and an expected provider failure without any live service", async () => {
    const crm: GetCustomerCapability = {
      async getCustomer(id) {
        return id === "c-1"
          ? { ok: true, value: { id, name: "Ada" } }
          : {
              ok: false,
              failure: {
                failureClass: FailureClass.NOT_FOUND,
                message: "customer not found",
              },
            };
      },
    };
    const found = await crm.getCustomer("c-1");
    assert.equal(found.ok, true);
    if (found.ok) assert.equal(found.value.name, "Ada");

    const missing = await crm.getCustomer("nope");
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.failure.failureClass, FailureClass.NOT_FOUND);
    }
  });

  it("leaves unexpected errors as rejections rather than provider failure results", async () => {
    const buggy: GetCustomerCapability = {
      async getCustomer() {
        throw new TypeError("programming error");
      },
    };
    await assert.rejects(() => buggy.getCustomer("c-1"), TypeError);
  });

  it("carries normalized transport metadata (httpStatus, retryAfterMs) through AdapterResult", async () => {
    const notifier: SendNotificationCapability = {
      async sendNotification() {
        return {
          ok: false,
          failure: {
            failureClass: FailureClass.RATE_LIMITED,
            message: "provider is rate limiting requests",
            httpStatus: 429,
            retryAfterMs: 5000,
          },
        };
      },
    };
    const result = await notifier.sendNotification({
      recipient: "a@example.com",
      body: "hello",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.failureClass, FailureClass.RATE_LIMITED);
      assert.equal(result.failure.httpStatus, 429);
      assert.equal(result.failure.retryAfterMs, 5000);
    }
  });

  it("does not require transport metadata: a failure with only a class and message is valid", () => {
    const bare: AdapterFailure = {
      failureClass: FailureClass.TRANSIENT,
      message: "temporary provider problem",
    };
    assert.equal(bare.httpStatus, undefined);
    assert.equal(bare.retryAfterMs, undefined);
  });
});

describe("request context", () => {
  it("is optional, and carries an idempotency key and correlation id when given", async () => {
    const seen: Array<AdapterRequestContext | undefined> = [];
    const notifier: SendNotificationCapability = {
      async sendNotification(_input, context) {
        seen.push(context);
        return { ok: true, value: { id: "n-1" } };
      },
    };
    const input = { recipient: "a@example.com", body: "hello" };
    await notifier.sendNotification(input);
    await notifier.sendNotification(input, {
      idempotencyKey: "op-1",
      correlationId: "corr-1",
    });
    assert.deepEqual(seen, [
      undefined,
      { idempotencyKey: "op-1", correlationId: "corr-1" },
    ]);
  });
});

describe("capability independence", () => {
  it("lets a provider implement only the capabilities it supports", async () => {
    const paymentsOnly: LookupTransactionCapability = {
      async lookupTransaction(id) {
        return { ok: true, value: { id, status: "settled" } };
      },
    };
    const fulfillmentReadOnly: GetOrderCapability = {
      async getOrder(id) {
        return { ok: true, value: { id, status: "shipped" } };
      },
    };
    const tx = await paymentsOnly.lookupTransaction("tx-1");
    const order = await fulfillmentReadOnly.getOrder("o-1");
    assert.equal(tx.ok && order.ok, true);
  });
});

describe("fulfillment input shape", () => {
  it("carries a reference and at least the line items", () => {
    const input: CreateFulfillmentOrderInput = {
      reference: "core-order-1",
      items: [{ sku: "sku-1", quantity: 2 }],
    };
    assert.equal(input.items.length, 1);
  });
});