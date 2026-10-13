import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigValidationError } from "@irs/config";
import { createProductionServer } from "./production.js";
import {
  INTEGRATION_ID,
  WEBHOOK_PATH,
  envelopeJson,
  parseJson,
  sign,
} from "./test-helpers.js";

/** Synthetic test secret: 32 bytes as 64 lowercase hex characters. */
const SECRET_HEX = "5a".repeat(32);
const SECRET_BYTES = new Uint8Array(Buffer.from(SECRET_HEX, "hex"));

/** Production wiring uses the real clock, so sign with the current time. */
function currentRequest(): { body: Buffer; headers: Record<string, string> } {
  const body = Buffer.from(envelopeJson());
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    body,
    headers: {
      "content-type": "application/json",
      "irs-signature": sign(body, timestamp, SECRET_BYTES),
    },
  };
}

const BASE_ENV = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/irs",
  REDIS_HOST: "localhost",
  REDIS_PORT: "6379",
  API_PORT: "3001",
  WEB_PORT: "3000",
};

const VALID_ENV = {
  ...BASE_ENV,
  IRS_WEBHOOK_SECRETS: `${INTEGRATION_ID}=${SECRET_HEX}`,
};

describe("production wiring", () => {
  it("returns 503 for a correctly signed, valid delivery until durable ingestion exists", async () => {
    const { app, port } = createProductionServer(VALID_ENV, { logger: false });
    try {
      assert.equal(port, 3001);
      const request = currentRequest();
      const response = await app.inject({
        method: "POST",
        url: WEBHOOK_PATH,
        headers: request.headers,
        payload: request.body,
      });
      assert.equal(response.statusCode, 503);
      const body = parseJson(response.body) as { error: string; requestId: string };
      assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
      assert.equal(body.error, "SERVICE_UNAVAILABLE");
      assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.ok(response.statusCode < 200 || response.statusCode >= 300);
    } finally {
      await app.close();
    }
  });

  it("never returns a 2xx for any outcome of a valid delivery", async () => {
    const { app } = createProductionServer(VALID_ENV, { logger: false });
    try {
      for (let i = 0; i < 3; i += 1) {
        const request = currentRequest();
        const response = await app.inject({
          method: "POST",
          url: WEBHOOK_PATH,
          headers: request.headers,
          payload: request.body,
        });
        assert.equal(response.statusCode, 503);
      }
    } finally {
      await app.close();
    }
  });

  it("starts with an absent or empty IRS_WEBHOOK_SECRETS and fails closed with 404", async () => {
    for (const env of [BASE_ENV, { ...BASE_ENV, IRS_WEBHOOK_SECRETS: "" }]) {
      const { app } = createProductionServer(env, { logger: false });
      try {
        const request = currentRequest();
        const response = await app.inject({
          method: "POST",
          url: WEBHOOK_PATH,
          headers: request.headers,
          payload: request.body,
        });
        assert.equal(response.statusCode, 404);
      } finally {
        await app.close();
      }
    }
  });

  it("fails to start with invalid secrets without echoing them", () => {
    const leaky = "ab".repeat(20); // 40 hex chars: too short, must not be echoed
    assert.throws(
      () =>
        createProductionServer(
          { ...BASE_ENV, IRS_WEBHOOK_SECRETS: `${INTEGRATION_ID}=${leaky}` },
          { logger: false },
        ),
      (error: unknown) =>
        error instanceof ConfigValidationError &&
        error.message.includes("IRS_WEBHOOK_SECRETS") &&
        !error.message.includes(leaky),
    );
  });

  it("fails to start with an invalid base configuration", () => {
    assert.throws(
      () =>
        createProductionServer(
          { IRS_WEBHOOK_SECRETS: VALID_ENV.IRS_WEBHOOK_SECRETS },
          { logger: false },
        ),
      ConfigValidationError,
    );
  });
});
