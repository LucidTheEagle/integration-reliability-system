import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadConfig } from "./index.js";

const validEnv = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/irs",
  REDIS_HOST: "localhost",
  REDIS_PORT: "6379",
  API_PORT: "4000",
  WEB_PORT: "3000",
};

function omit(
  obj: Record<string, string>,
  key: string,
): Record<string, string> {
  const clone = { ...obj };
  delete clone[key];
  return clone;
}

describe("loadConfig — valid configuration", () => {
  it("returns a typed configuration object grouped by subsystem", () => {
    const config = loadConfig(validEnv);

    expect(config).toEqual({
      database: { url: "postgresql://user:password@localhost:5432/irs" },
      redis: { host: "localhost", port: 6379 },
      api: { port: 4000 },
      web: { port: 3000 },
    });
  });

  it("converts decimal port strings (always strings from the env) into real numbers", () => {
    const config = loadConfig(validEnv);
    expect(typeof config.redis.port).toBe("number");
    expect(typeof config.api.port).toBe("number");
    expect(typeof config.web.port).toBe("number");
  });

  it("returns an immutable object", () => {
    const config = loadConfig(validEnv);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.redis)).toBe(true);
    expect(() => {
      // @ts-expect-error — config is readonly at the type level too
      config.api.port = 9999;
    }).toThrow();
  });

  it("ignores unrelated environment variables (e.g. PATH, HOME)", () => {
    expect(() =>
      loadConfig({ ...validEnv, PATH: "/usr/bin", HOME: "/root" }),
    ).not.toThrow();
  });
});

describe("loadConfig — missing required values", () => {
  it.each([
    "DATABASE_URL",
    "REDIS_HOST",
    "REDIS_PORT",
    "API_PORT",
    "WEB_PORT",
  ])("throws ConfigValidationError when %s is missing", (key) => {
    expect(() => loadConfig(omit(validEnv, key))).toThrow(
      ConfigValidationError,
    );
  });

  it("reports every missing value in one error, not just the first", () => {
    expect.assertions(6);
    try {
      loadConfig({});
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const message = (error as ConfigValidationError).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("REDIS_HOST");
      expect(message).toContain("REDIS_PORT");
      expect(message).toContain("API_PORT");
      expect(message).toContain("WEB_PORT");
    }
  });

  it("distinguishes a missing port from an invalid one", () => {
    // REDIS_PORT is validated as a string first (regex, then range), so
    // an absent key fails Zod's own "invalid_type" check directly —
    // there's no coercion step left to collapse "missing" and "invalid"
    // into the same signal the way z.coerce.number() used to.
    expect.assertions(2);
    try {
      loadConfig(omit(validEnv, "REDIS_PORT"));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toBe(
        "Invalid configuration:\n  - REDIS_PORT: is required",
      );
    }
  });
});

describe("loadConfig — invalid constrained values", () => {
  it("rejects a DATABASE_URL that is not a postgres connection string", () => {
    expect(() =>
      loadConfig({ ...validEnv, DATABASE_URL: "mysql://localhost/irs" }),
    ).toThrow(ConfigValidationError);
  });

  it("rejects an empty DATABASE_URL", () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: "" })).toThrow(
      ConfigValidationError,
    );
  });

  it("produces exactly one issue for DATABASE_URL, even though its check tests two things", () => {
    // DATABASE_URL's refine tests both "non-empty" and "starts with
    // postgres(ql)://" in a single predicate, so a value that fails both
    // (like "") still produces exactly one Zod issue — and therefore one
    // reported line — for the field, not two.
    expect.assertions(2);
    try {
      loadConfig({ ...validEnv, DATABASE_URL: "" });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toHaveLength(1);
    }
  });

  it("rejects an empty REDIS_HOST", () => {
    expect(() => loadConfig({ ...validEnv, REDIS_HOST: "" })).toThrow(
      ConfigValidationError,
    );
  });

  it.each(["REDIS_PORT", "API_PORT", "WEB_PORT"])(
    "rejects a non-numeric %s",
    (key) => {
      expect(() => loadConfig({ ...validEnv, [key]: "not-a-port" })).toThrow(
        ConfigValidationError,
      );
    },
  );

  it.each(["REDIS_PORT", "API_PORT", "WEB_PORT"])(
    "rejects %s below the valid port range",
    (key) => {
      expect(() => loadConfig({ ...validEnv, [key]: "0" })).toThrow(
        ConfigValidationError,
      );
    },
  );

  it.each(["REDIS_PORT", "API_PORT", "WEB_PORT"])(
    "rejects %s above the valid port range",
    (key) => {
      expect(() => loadConfig({ ...validEnv, [key]: "70000" })).toThrow(
        ConfigValidationError,
      );
    },
  );

  it.each(["REDIS_PORT", "API_PORT", "WEB_PORT"])(
    "rejects a decimal-point %s (strict decimal only, not just anything Number() accepts)",
    (key) => {
      expect(() => loadConfig({ ...validEnv, [key]: "5432.5" })).toThrow(
        ConfigValidationError,
      );
    },
  );

  it.each(["REDIS_PORT", "API_PORT", "WEB_PORT"])(
    "rejects a hex %s that Number() would otherwise silently accept",
    (key) => {
      expect(() => loadConfig({ ...validEnv, [key]: "0x1A" })).toThrow(
        ConfigValidationError,
      );
    },
  );

  it.each(["REDIS_PORT", "API_PORT", "WEB_PORT"])(
    "rejects a whitespace-padded %s",
    (key) => {
      expect(() => loadConfig({ ...validEnv, [key]: " 6379 " })).toThrow(
        ConfigValidationError,
      );
    },
  );

  it.each(["REDIS_PORT", "API_PORT", "WEB_PORT"])(
    "rejects an empty-string %s",
    (key) => {
      expect(() => loadConfig({ ...validEnv, [key]: "" })).toThrow(
        ConfigValidationError,
      );
    },
  );

  it.each(["REDIS_PORT", "API_PORT", "WEB_PORT"])(
    "rejects exponential notation for %s that Number() would otherwise silently accept",
    (key) => {
      expect(() => loadConfig({ ...validEnv, [key]: "1e3" })).toThrow(
        ConfigValidationError,
      );
    },
  );
});

describe("loadConfig — accepts valid boundary values", () => {
  it.each([
    "postgres://user:password@localhost:5432/irs",
    "postgresql://user:password@localhost:5432/irs",
  ])("accepts valid PostgreSQL URL scheme: %s", (url) => {
    expect(() =>
      loadConfig({ ...validEnv, DATABASE_URL: url }),
    ).not.toThrow();
  });

  it.each(["REDIS_PORT", "API_PORT", "WEB_PORT"])(
    "accepts the lower valid boundary for %s",
    (key) => {
      expect(() =>
        loadConfig({ ...validEnv, [key]: "1" }),
      ).not.toThrow();
    },
  );

  it.each(["REDIS_PORT", "API_PORT", "WEB_PORT"])(
    "accepts the upper valid boundary for %s",
    (key) => {
      expect(() =>
        loadConfig({ ...validEnv, [key]: "65535" }),
      ).not.toThrow();
    },
  );
});

describe("loadConfig — error messages never echo the raw value", () => {
  it("produces a deterministic, human-readable message with no value in it", () => {
    expect.assertions(2);
    try {
      loadConfig({ ...validEnv, REDIS_PORT: "not-a-port" });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toBe(
        "Invalid configuration:\n  - REDIS_PORT: must be a whole number between 1 and 65535",
      );
    }
  });

  it("never includes the DATABASE_URL value (which embeds a password) in its error", () => {
    expect.assertions(2);
    try {
      // Wrong scheme, so this fails validation — but it still embeds a
      // credential, exactly like a real DATABASE_URL would.
      loadConfig({
        ...validEnv,
        DATABASE_URL: "mysql://admin:hunter2@internal-db:5432/prod",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).not.toContain(
        "hunter2",
      );
    }
  });

  it("never includes a raw port value in its error, even indirectly", () => {
    expect.assertions(2);
    try {
      loadConfig({ ...validEnv, WEB_PORT: "not-a-real-port-99999" });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).not.toContain(
        "not-a-real-port-99999",
      );
    }
  });

  it("exposes the structured issue list alongside the formatted message", () => {
    expect.assertions(2);
    try {
      loadConfig({ ...validEnv, REDIS_HOST: "" });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues).toEqual([
        expect.stringContaining("REDIS_HOST"),
      ]);
    }
  });
});