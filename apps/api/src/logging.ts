/** Minimal log destination (matches pino/Fastify stream contract). */
export interface LogStream {
  write(message: string): void;
}

/**
 * Safe logging configuration.
 *
 * Request and response objects are never logged wholesale: the serializers
 * emit only the HTTP method and the URL path (no query string), and the
 * status code. The application hooks log no headers and no body. The
 * redaction list is a second line of defence for accidental additions.
 *
 * Application logs are operational telemetry. They are NOT a durable
 * security-audit record (Task 011A).
 */

/** Strips the query string and fragment from a request URL. */
export function safePath(url: string | undefined): string {
  if (url === undefined) return "";
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

export interface LoggerSettings {
  readonly level?: string;
  readonly stream?: LogStream;
}

export function buildLoggerOptions(settings: LoggerSettings): {
  level: string;
  stream?: LogStream;
  serializers: Record<string, (value: unknown) => unknown>;
  redact: { paths: string[]; remove: true };
} {
  const options: {
    level: string;
    stream?: LogStream;
    serializers: Record<string, (value: unknown) => unknown>;
    redact: { paths: string[]; remove: true };
  } = {
    level: settings.level ?? "info",
    serializers: {
      req(value: unknown) {
        const req = value as { method?: string; url?: string };
        return { method: req.method, path: safePath(req.url) };
      },
      res(value: unknown) {
        const res = value as { statusCode?: number };
        return { statusCode: res.statusCode };
      },
    },
    redact: {
      paths: [
        "req.headers",
        "headers",
        "*.headers",
        "body",
        "*.body",
        "rawBody",
        "*.rawBody",
        "secret",
        "*.secret",
        "signature",
        "*.signature",
        "authorization",
        "*.authorization",
        "query",
        "*.query",
      ],
      remove: true,
    },
  };
  if (settings.stream !== undefined) options.stream = settings.stream;
  return options;
}
