/**
 * Generic API error contract.
 *
 * Every error response is exactly
 *
 *   {"error": "<FIXED_CODE>", "requestId": "<server-generated UUID>"}
 *
 * The code is one of a fixed, closed set. Responses never include secrets,
 * headers, body fragments, rejected paths, stack traces, internal error
 * messages, framework (`FST_ERR_*`) codes, or verifier rejection details.
 */

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "REQUEST_TIMEOUT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

const STATUS: Readonly<Record<ApiErrorCode, number>> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  REQUEST_TIMEOUT: 408,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export interface ApiErrorBody {
  readonly error: ApiErrorCode;
  readonly requestId: string;
}

export function statusFor(code: ApiErrorCode): number {
  return STATUS[code];
}

export function errorBody(code: ApiErrorCode, requestId: string): ApiErrorBody {
  return { error: code, requestId };
}

/**
 * Maps an error raised by the framework (or a hook) to a generic code,
 * using only its numeric HTTP status. The error's message is never read.
 */
export function codeForFrameworkError(error: unknown): ApiErrorCode {
  const status =
    typeof error === "object" && error !== null
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;

  if (typeof status !== "number" || !Number.isInteger(status)) {
    return "INTERNAL_ERROR";
  }
  switch (status) {
    case 404:
      return "NOT_FOUND";
    case 408:
      return "REQUEST_TIMEOUT";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return status >= 400 && status < 500 ? "BAD_REQUEST" : "INTERNAL_ERROR";
  }
}
