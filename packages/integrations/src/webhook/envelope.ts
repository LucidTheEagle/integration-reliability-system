/**
 * Internal envelope validation for the IRS V1 webhook protocol.
 * Not part of the package's public API.
 */

/** The validated, normalized representation used downstream. */
export interface VerifiedWebhookEnvelope {
  readonly externalEventId: string;
  readonly eventType: string;
  readonly resourceType: string;
  readonly resourceId: string;
  /** The validated instant (explicit timezone offset applied). */
  readonly occurredAt: Date;
  readonly schemaVersion: string;
  readonly correlationId?: string;
  /**
   * Parsed JSON object, referenced as parsed (not cloned). The envelope
   * itself is frozen; the payload's runtime contents are not.
   */
  readonly payload: Readonly<Record<string, unknown>>;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "externalEventId",
  "eventType",
  "resourceType",
  "resourceId",
  "occurredAt",
  "schemaVersion",
  "correlationId",
  "payload",
]);

const MAX_EXTERNAL_EVENT_ID_BYTES = 255;
const MAX_EVENT_TYPE_CHARS = 128;
const MAX_RESOURCE_TYPE_BYTES = 128;
const MAX_RESOURCE_ID_BYTES = 255;
const MAX_SCHEMA_VERSION_BYTES = 64;
const MAX_CORRELATION_ID_BYTES = 128;

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

const OCCURRED_AT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty, not whitespace-only, within the UTF-8 byte limit. Verbatim. */
function isIdentifier(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Strict ISO-8601 date-time with an explicit timezone ("Z" or +/-hh:mm),
 * optional fraction of 1-3 digits. Returns the instant, or null.
 * Components are range- and calendar-checked by hand; Date.parse is
 * not used to decide validity.
 */
function parseOccurredAt(value: string): Date | null {
  const match = OCCURRED_AT_PATTERN.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = match[7] === undefined ? 0 : Number(match[7].padEnd(3, "0"));
  const zone = match[8] as string;

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMins = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }

  // setUTCFullYear avoids Date.UTC's mapping of years 0-99 to 1900-1999.
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, millis);
  instant.setTime(instant.getTime() - offsetMinutes * 60_000);
  return instant;
}

export type EnvelopeValidation =
  | { readonly ok: true; readonly envelope: VerifiedWebhookEnvelope }
  | { readonly ok: false };

const INVALID: EnvelopeValidation = { ok: false };

export function validateEnvelope(value: unknown): EnvelopeValidation {
  if (!isPlainObject(value)) return INVALID;

  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) return INVALID;
  }

  const get = (key: string): unknown =>
    Object.hasOwn(value, key) ? value[key] : undefined;

  const externalEventId = get("externalEventId");
  const eventType = get("eventType");
  const resourceType = get("resourceType");
  const resourceId = get("resourceId");
  const occurredAtText = get("occurredAt");
  const schemaVersion = get("schemaVersion");
  const payload = get("payload");

  if (!isIdentifier(externalEventId, MAX_EXTERNAL_EVENT_ID_BYTES)) {
    return INVALID;
  }
  if (
    !isIdentifier(eventType, Number.MAX_SAFE_INTEGER) ||
    eventType.length > MAX_EVENT_TYPE_CHARS ||
    !EVENT_TYPE_PATTERN.test(eventType)
  ) {
    return INVALID;
  }
  if (!isIdentifier(resourceType, MAX_RESOURCE_TYPE_BYTES)) return INVALID;
  if (!isIdentifier(resourceId, MAX_RESOURCE_ID_BYTES)) return INVALID;
  if (!isIdentifier(schemaVersion, MAX_SCHEMA_VERSION_BYTES)) return INVALID;

  if (typeof occurredAtText !== "string") return INVALID;
  const occurredAt = parseOccurredAt(occurredAtText);
  if (occurredAt === null) return INVALID;

  if (!isPlainObject(payload)) return INVALID;

  if (Object.hasOwn(value, "correlationId")) {
    const correlationId = value["correlationId"];
    if (!isIdentifier(correlationId, MAX_CORRELATION_ID_BYTES)) return INVALID;
    return {
      ok: true,
      envelope: Object.freeze({
        externalEventId,
        eventType,
        resourceType,
        resourceId,
        occurredAt,
        schemaVersion,
        correlationId,
        payload,
      }),
    };
  }

  return {
    ok: true,
    envelope: Object.freeze({
      externalEventId,
      eventType,
      resourceType,
      resourceId,
      occurredAt,
      schemaVersion,
      payload,
    }),
  };
}
