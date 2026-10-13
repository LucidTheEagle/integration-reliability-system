import { z } from "zod";

const DATABASE_URL_PATTERN = /^postgres(ql)?:\/\//;

/**
 * Strict decimal port schema.
 *
 * Deliberately starts from `z.string()` rather than `z.coerce.number()`.
 * Coercion accepts far more than a config file should: hex ("0x1000"),
 * exponential notation ("1e3"), leading/trailing whitespace, and "" (which
 * coerces to 0). Requiring the raw value to match `^[0-9]+$` first means a
 * port is only ever accepted in the one form a human would actually type
 * into a .env file, and only then converted to a number and range-checked.
 */
const PORT_MESSAGE = "must be a whole number between 1 and 65535";

const portSchema = z
  .string()
  .regex(/^[0-9]+$/, PORT_MESSAGE)
  .transform((value) => Number(value))
  .refine((value) => value >= 1 && value <= 65535, PORT_MESSAGE);

/**
 * Raw environment variable schema.
 *
 * This is the single source of truth for which environment variables
 * the Integration Reliability System requires and what "valid" means
 * for each one. It validates against `.env.example`'s current set of
 * five variables only — it does not guess at variables that might be
 * added later.
 */
const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .refine((value) => value.length > 0 && DATABASE_URL_PATTERN.test(value), {
      message: "must be a non-empty postgres:// or postgresql:// connection string",
    }),
  REDIS_HOST: z.string().min(1, "must not be empty"),
  REDIS_PORT: portSchema,
  API_PORT: portSchema,
  WEB_PORT: portSchema,
});

type Env = z.infer<typeof envSchema>;

/**
 * Typed, validated runtime configuration for the Integration Reliability
 * System. Grouped by subsystem rather than mirroring the flat env var
 * names, so call sites read as `config.redis.port`, not `config.REDIS_PORT`.
 */
export interface AppConfig {
  readonly database: {
    readonly url: string;
  };
  readonly redis: {
    readonly host: string;
    readonly port: number;
  };
  readonly api: {
    readonly port: number;
  };
  readonly web: {
    readonly port: number;
  };
}

/**
 * Thrown when one or more configuration values are missing or invalid.
 *
 * Messages deliberately never include the raw value that was supplied.
 * DATABASE_URL embeds a database password, so echoing it back in an
 * error would leak a credential into logs, CI output, or an error
 * tracker; the same rule is applied to every field rather than
 * special-casing DATABASE_URL, since none of these should be assumed
 * safe to print in every downstream sink this error might end up in.
 */
export class ConfigValidationError extends Error {
  public readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
    this.name = "ConfigValidationError";
    this.issues = issues;
    Object.setPrototypeOf(this, ConfigValidationError.prototype);
  }
}

/**
 * Converts a ZodError into a flat, value-free list of "KEY: reason"
 * strings. Every field in the schema starts from `z.string()`, so a
 * missing key always fails with Zod's own "invalid_type" issue —
 * that's what "is required" below is keyed on. Any other issue code
 * means the key was present but didn't satisfy its constraint, and
 * uses that check's own message (set explicitly above; never Zod's
 * default wording, and never the offending value).
 *
 * Only the first issue per field is kept: a field can fail more than
 * one check at once, but the config problem is "this value is
 * wrong," not a list of every reason it's wrong.
 */
function formatIssues(error: z.ZodError<Env>): string[] {
  const messages: string[] = [];
  const reported = new Set<string>();

  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "(unknown)");
    if (reported.has(key)) {
      continue;
    }
    reported.add(key);

    if (issue.code === "invalid_type") {
      messages.push(`${key}: is required`);
      continue;
    }

    messages.push(`${key}: ${issue.message}`);
  }

  return messages;
}

/**
 * Validates a raw environment-like object and returns a typed, frozen
 * configuration object.
 *
 * This is the single boundary through which the rest of the system
 * should read configuration — application code should not read
 * `process.env` directly (see the Master Specification's "single
 * configuration boundary" constraint).
 *
 * `source` defaults to `process.env` so application code calls
 * `loadConfig()` with no arguments; tests pass a plain object so they
 * never have to mutate the real `process.env`.
 *
 * @throws {ConfigValidationError} if any required value is missing or
 * any value fails its constraint. All issues are reported together
 * (Zod's `safeParse` does not stop at the first failure), so a single
 * run surfaces every problem instead of one per fix-and-retry cycle.
 */
export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new ConfigValidationError(formatIssues(result.error));
  }

  const env = result.data;

  return Object.freeze({
    database: Object.freeze({
      url: env.DATABASE_URL,
    }),
    redis: Object.freeze({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
    }),
    api: Object.freeze({
      port: env.API_PORT,
    }),
    web: Object.freeze({
      port: env.WEB_PORT,
    }),
  });
}

// ---------------------------------------------------------------------------
// Webhook secrets (Task 010A, decision D-017)
// ---------------------------------------------------------------------------

const WEBHOOK_SECRETS_VARIABLE = "IRS_WEBHOOK_SECRETS";

/** Minimum secret length accepted by the Task 010 verifier. */
const MIN_WEBHOOK_SECRET_BYTES = 32;
const MIN_WEBHOOK_SECRET_HEX_CHARS = MIN_WEBHOOK_SECRET_BYTES * 2;

/** Canonical lowercase UUID text of any version (8-4-4-4-12 lowercase hex). */
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LOWERCASE_HEX_PATTERN = /^[0-9a-f]+$/;

/**
 * Webhook secrets keyed by `Integration.id` (canonical lowercase UUID).
 * Values are the exact secret bytes handed to the Task 010 verifier. Treat
 * the map and its values as read-only.
 */
export type WebhookSecrets = ReadonlyMap<string, Uint8Array>;

/**
 * Loads the initial environment-backed webhook secrets.
 *
 * `IRS_WEBHOOK_SECRETS` is a comma-separated list of
 * `<integration-uuid>=<hex-secret>` entries:
 *
 * - the key is a canonical lowercase UUID (any version): `Integration.id`;
 * - the secret is lowercase hexadecimal of even length and at least 64
 *   characters, and is decoded to the secret bytes (at least 32 bytes);
 * - no whitespace, empty entries, or duplicate integration IDs are allowed.
 *
 * An absent or empty variable yields an empty map (no integration can then
 * be authenticated, so every webhook fails closed).
 *
 * This mechanism is limited to local development, demonstrations, and
 * controlled mock-provider use (Master Specification, Section 18). It does
 * not perform any database lookup.
 *
 * Error messages identify the variable and the 1-based entry index only;
 * they never contain a secret, a key, or any part of the raw value.
 *
 * @throws {ConfigValidationError} if any entry is invalid.
 */
export function loadWebhookSecrets(
  source: NodeJS.ProcessEnv = process.env,
): WebhookSecrets {
  const raw = source[WEBHOOK_SECRETS_VARIABLE];
  const secrets = new Map<string, Uint8Array>();
  if (raw === undefined || raw.length === 0) {
    return secrets;
  }

  const fail = (entryNumber: number, reason: string): never => {
    throw new ConfigValidationError([
      `${WEBHOOK_SECRETS_VARIABLE}: entry ${entryNumber}: ${reason}`,
    ]);
  };

  const entries = raw.split(",");
  entries.forEach((entry, index) => {
    const entryNumber = index + 1;
    const parts = entry.split("=");
    if (parts.length !== 2) {
      return fail(entryNumber, "must be <integration-uuid>=<hex-secret>");
    }
    const [integrationId, secretHex] = parts as [string, string];

    if (!CANONICAL_UUID_PATTERN.test(integrationId)) {
      return fail(entryNumber, "integration ID must be a canonical lowercase UUID");
    }
    if (!LOWERCASE_HEX_PATTERN.test(secretHex)) {
      return fail(entryNumber, "secret must be lowercase hexadecimal");
    }
    if (secretHex.length % 2 !== 0) {
      return fail(entryNumber, "secret must have an even number of hex characters");
    }
    if (secretHex.length < MIN_WEBHOOK_SECRET_HEX_CHARS) {
      return fail(
        entryNumber,
        `secret must be at least ${MIN_WEBHOOK_SECRET_BYTES} bytes (${MIN_WEBHOOK_SECRET_HEX_CHARS} hex characters)`,
      );
    }
    if (secrets.has(integrationId)) {
      return fail(entryNumber, "duplicate integration ID");
    }

    secrets.set(integrationId, new Uint8Array(Buffer.from(secretHex, "hex")));
    return undefined;
  });

  return secrets;
}
