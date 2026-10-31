import * as nodeCrypto from "node:crypto";

// Task 012B (Gate A, option E; B2-11; PL-7; FD-5): the worker's AuditEntry
// id generator. Node's native UUIDv7 only, with no fallback: if the runtime
// does not offer it, the generator cannot be obtained and the worker must not
// start (012B-3's startup calls this first and exits non-zero on the error).
// A namespace import, so a missing export cannot fail at module load.

/** The classified code of a runtime without a UUIDv7 generator. */
export const AUDIT_ID_V7_UNAVAILABLE = "AUDIT_ID_V7_UNAVAILABLE";

export class AuditIdGeneratorUnavailable extends Error {
  override readonly name = "AuditIdGeneratorUnavailable";
  readonly code = AUDIT_ID_V7_UNAVAILABLE;
  constructor() {
    super(`audit id generator unavailable (${AUDIT_ID_V7_UNAVAILABLE})`);
  }
}

/** The one capability this module needs from its source (injected in tests). */
export interface AuditIdSource {
  readonly randomUUIDv7?: unknown;
}

/**
 * Returns a generator of UUIDv7 strings from `source.randomUUIDv7`, or throws
 * AuditIdGeneratorUnavailable when it is not a function. There is no other path.
 */
export function requireAuditIdGenerator(source: AuditIdSource = nodeCrypto): () => string {
  const generate = source.randomUUIDv7;
  if (typeof generate !== "function") throw new AuditIdGeneratorUnavailable();
  return () => generate.call(source) as string;
}
