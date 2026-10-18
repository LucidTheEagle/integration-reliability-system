import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigValidationError } from "@irs/config";
import type { CreateDatabaseOptions, Database } from "@irs/db";
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

/**
 * Database doubles for the injected factory (PROD-1): no test here creates
 * a real client, so nothing can reach a database.
 */
function unavailableDatabase(): Database {
  return {
    prisma: {
      $transaction: () => Promise.reject(new Error("timeout exceeded when trying to connect")),
    },
    monotonicNow: () => 0,
    ping: () => Promise.reject(new Error("timeout exceeded when trying to connect")),
  } as unknown as Database;
}

/** A fake interactive transaction that walks ingestEvent's NEW path. */
function acceptingDatabase(): { db: Database; statements: string[] } {
  const statements: string[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      statements.push(strings.join("$"));
      return [{ configStatus: "ACTIVE" }];
    },
    event: {
      createManyAndReturn: async () => {
        statements.push("event.createManyAndReturn");
        return [{ id: "0190f3a2-0000-7000-8000-0000000000e1" }];
      },
    },
    auditEntry: {
      createMany: async () => {
        statements.push("auditEntry.createMany");
        return { count: 1 };
      },
    },
  };
  const db = {
    prisma: { $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx) },
    monotonicNow: () => 0,
    ping: async () => undefined,
  } as unknown as Database;
  return { db, statements };
}

function factory(db: Database) {
  const created: CreateDatabaseOptions[] = [];
  return {
    created,
    createDatabase: (options: CreateDatabaseOptions) => {
      created.push(options);
      return db;
    },
  };
}

describe("production wiring (PROD-1)", () => {
  it("returns { app, port, db }, creating the database from DATABASE_URL through the injected factory", async () => {
    const db = unavailableDatabase();
    const injected = factory(db);
    const server = createProductionServer(VALID_ENV, { logger: false }, injected);
    try {
      assert.equal(server.port, 3001);
      assert.equal(server.db, db);
      assert.deepEqual(injected.created, [{ connectionString: VALID_ENV.DATABASE_URL }]);
    } finally {
      await server.app.close();
    }
  });

  it("wires the durable handoff: a signed, valid delivery runs ingestEvent and is answered 202", async () => {
    const accepting = acceptingDatabase();
    const { app } = createProductionServer(VALID_ENV, { logger: false }, factory(accepting.db));
    try {
      const request = currentRequest();
      const response = await app.inject({ method: "POST", url: WEBHOOK_PATH, headers: request.headers, payload: request.body });
      assert.equal(response.statusCode, 202);
      const body = parseJson(response.body) as { status: string; requestId: string };
      assert.equal(body.status, "ACCEPTED");
      assert.equal(accepting.statements[0], 'SELECT "public"."irs_integration_config_status_for_share"($) AS "configStatus"');
      assert.deepEqual(accepting.statements.slice(1), ["event.createManyAndReturn", "auditEntry.createMany"]);
    } finally {
      await app.close();
    }
  });

  it("returns 503 when the database is unavailable, and never a 2xx", async () => {
    const { app } = createProductionServer(VALID_ENV, { logger: false }, factory(unavailableDatabase()));
    try {
      for (let i = 0; i < 3; i += 1) {
        const request = currentRequest();
        const response = await app.inject({ method: "POST", url: WEBHOOK_PATH, headers: request.headers, payload: request.body });
        assert.equal(response.statusCode, 503);
        const body = parseJson(response.body) as { error: string; requestId: string };
        assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
        assert.equal(body.error, "SERVICE_UNAVAILABLE");
        assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
    } finally {
      await app.close();
    }
  });

  it("starts with an absent or empty IRS_WEBHOOK_SECRETS and fails closed with 404", async () => {
    for (const env of [BASE_ENV, { ...BASE_ENV, IRS_WEBHOOK_SECRETS: "" }]) {
      const { app } = createProductionServer(env, { logger: false }, factory(unavailableDatabase()));
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

  it("fails to start with invalid secrets without echoing them, and creates no database", () => {
    const leaky = "ab".repeat(20); // 40 hex chars: too short, must not be echoed
    const injected = factory(unavailableDatabase());
    assert.throws(
      () =>
        createProductionServer(
          { ...BASE_ENV, IRS_WEBHOOK_SECRETS: `${INTEGRATION_ID}=${leaky}` },
          { logger: false },
          injected,
        ),
      (error: unknown) =>
        error instanceof ConfigValidationError &&
        error.message.includes("IRS_WEBHOOK_SECRETS") &&
        !error.message.includes(leaky),
    );
    assert.equal(injected.created.length, 0);
  });

  it("fails to start with an invalid base configuration, and creates no database", () => {
    const injected = factory(unavailableDatabase());
    assert.throws(
      () =>
        createProductionServer(
          { IRS_WEBHOOK_SECRETS: VALID_ENV.IRS_WEBHOOK_SECRETS },
          { logger: false },
          injected,
        ),
      ConfigValidationError,
    );
    assert.equal(injected.created.length, 0);
  });
});
