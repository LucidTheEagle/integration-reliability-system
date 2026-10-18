import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex, toAuditRow, toEventRow } from "./event-ingestion.js";
import type { EventIngestionInput } from "./event-ingestion.js";

// The §7.2 mapping as pure functions (the database half is event-ingestion.db.test.ts).

const RAW = new TextEncoder().encode('{"b":1, "a":"é"}');
const INPUT: EventIngestionInput = {
  requestId: "0190f3a2-0000-7000-8000-000000000001",
  integrationId: "0190f3a2-7b1c-7a55-8f0e-2b6d3c4a5e61",
  externalEventId: "evt_1",
  eventType: "order.created",
  resourceType: "order",
  resourceId: "ord_1",
  occurredAt: new Date("2026-10-17T00:00:00.000Z"),
  schemaVersion: "1",
  correlationId: null,
  payload: { b: 1, a: "é" },
  rawBody: RAW,
  receivedAt: new Date("2026-10-17T10:00:00.000Z"),
  contentType: "application/json",
};

describe("§7.2 mapping", () => {
  it("sha256Hex is the lowercase hex SHA-256 of the bytes", () => {
    const digest = sha256Hex(RAW);
    assert.equal(digest, createHash("sha256").update(RAW).digest("hex"));
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  it("maps every Event column; status VALIDATED; receivedAt explicit; metadata allowlisted; no id", () => {
    const digest = sha256Hex(RAW);
    const row = toEventRow(INPUT, digest);
    assert.deepEqual(row, {
      integrationId: INPUT.integrationId,
      externalEventId: "evt_1",
      eventType: "order.created",
      resourceType: "order",
      resourceId: "ord_1",
      payload: { b: 1, a: "é" },
      metadata: { schemaVersion: 1, requestId: INPUT.requestId, contentType: "application/json", bodyByteLength: RAW.byteLength },
      occurredAt: INPUT.occurredAt,
      receivedAt: INPUT.receivedAt,
      status: "VALIDATED",
      schemaVersion: "1",
      correlationId: null,
      rawBody: new Uint8Array(RAW),
      rawBodySha256: digest,
    });
    assert.equal("id" in row, false, "the id comes from the client-side uuid(7) default");
    assert.notEqual(row.rawBody, INPUT.rawBody, "the stored bytes are an independent copy");
  });

  it("maps the EVENT_RECEIVED audit row (id = requestId; createdAt = receivedAt; no payload)", () => {
    const digest = sha256Hex(RAW);
    assert.deepEqual(toAuditRow(INPUT, "event-id", "NEW", null, digest), {
      id: INPUT.requestId,
      actorType: "EXTERNAL_SENDER",
      actorId: null,
      action: "EVENT_RECEIVED",
      entityType: "EVENT",
      entityId: "event-id",
      metadata: {
        schemaVersion: 1,
        integrationId: INPUT.integrationId,
        disposition: "NEW",
        contentMatches: null,
        bodyByteLength: RAW.byteLength,
        rawBodySha256: digest,
      },
      createdAt: INPUT.receivedAt,
    });
    assert.equal(toAuditRow(INPUT, "e", "DUPLICATE", false, digest).metadata.contentMatches, false);
  });
});
