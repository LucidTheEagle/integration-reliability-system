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