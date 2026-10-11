/**
 * Pure response helpers. Every response gets an explicit Content-Type, and
 * error bodies share one shape: `{ error: code, message, ...details }`.
 */

const JSON_TYPE = "application/json; charset=utf-8";
const TEXT_TYPE = "text/plain; charset=utf-8";

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", JSON_TYPE);
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function text(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", TEXT_TYPE);
  return new Response(body, { ...init, headers });
}

export function noContent(headers: HeadersInit = {}): Response {
  return new Response(null, { status: 204, headers });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  headers: HeadersInit = {},
): Response {
  return json({ error: code, message, ...details }, { status, headers });
}

export function badRequest(message: string, details: Readonly<Record<string, unknown>> = {}): Response {
  return errorResponse(400, "bad_request", message, details);
}

export function unauthorized(): Response {
  return errorResponse(401, "unauthorized", "Authentication required", {}, {
    "www-authenticate": 'Bearer realm="api"',
  });
}

export function forbidden(message = "Forbidden"): Response {
  return errorResponse(403, "forbidden", message);
}

export function notFound(message = "Not Found"): Response {
  return errorResponse(404, "not_found", message);
}

export function methodNotAllowed(allow: readonly string[]): Response {
  return errorResponse(405, "method_not_allowed", "Method Not Allowed", {}, { allow: allow.join(", ") });
}

export function payloadTooLarge(maxBytes: number): Response {
  return errorResponse(413, "payload_too_large", `Request body must not exceed ${maxBytes} bytes`);
}

export function unsupportedMediaType(expected: string): Response {
  return errorResponse(415, "unsupported_media_type", `Content-Type must be ${expected}`);
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return errorResponse(429, "rate_limited", "Too Many Requests", {}, {
    "retry-after": String(retryAfterSeconds),
  });
}

/** Generic 500. `errorId` lets an operator find the matching server-side log line. */
export function internalError(errorId: string): Response {
  return errorResponse(500, "internal_error", "Internal Server Error", { errorId });
}

export function serviceUnavailable(message = "Service Unavailable"): Response {
  return errorResponse(503, "service_unavailable", message);
}

/** Returns a copy of `response` with `headers` set, overwriting existing values. */
export function withHeaders(response: Response, headers: Readonly<Record<string, string>>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) {
    merged.set(name, value);
  }
  return copyWithHeaders(response, merged);
}

/** Returns a copy of `response` with `defaults` added where not already set. */
export function withDefaultHeaders(response: Response, defaults: Readonly<Record<string, string>>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(defaults)) {
    if (!merged.has(name)) merged.set(name, value);
  }
  return copyWithHeaders(response, merged);
}

function copyWithHeaders(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Adds `value` to a `Vary` header value without duplicating it. */
export function appendVary(current: string | null, value: string): string {
  const parts = (current ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");
  const present = parts.some((part) => part.toLowerCase() === value.toLowerCase());
  return present ? parts.join(", ") : [...parts, value].join(", ");
}
