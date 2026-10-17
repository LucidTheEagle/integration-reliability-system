import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient, TransactionClient } from "./client.js";

// AL-T6a: a compile-time probe, informational only (Rev 1.7 §9.1). The root
// client is expected to be assignable to TransactionClient, so the type
// system gives no protection against passing it; the runner's runtime guard
// does. If this assignment stops compiling, the build fails and §9.1 must be
// revisited.
const rootClientAsTransaction = (client: PrismaClient): TransactionClient => client;

// Negative control: proves the probe really type-checks.
// @ts-expect-error an empty object is not a TransactionClient
const notATransactionClient: TransactionClient = {};

describe("AL-T6a type probe", () => {
  it("root PrismaClient is assignable to TransactionClient (compiled)", () => {
    assert.equal(typeof rootClientAsTransaction, "function");
    assert.deepEqual(notATransactionClient, {});
  });
});
