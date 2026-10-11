/**
 * Middleware: `(next: Handler) => Handler`.
 *
 * Each factory takes exactly the dependencies it uses as explicit options, so
 * it can be read, tested and reused on its own. `compose` stacks them.
 */
import {
  appendVary,
  badRequest,
  forbidden,
  internalError,
  noContent,
  payloadTooLarge,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
  withDefaultHeaders,
  withHeaders,
} from "./http.ts";
import { isHttps, pathOf } from "./request.ts";
import type { Cancel, Clock, Logger, Middleware, RateLimitHit, RateLimitStore, Result } from "./types.ts";

/** `compose(a, b, c)(handler)` runs a → b → c → handler, then back out. */
export function compose(...middleware: readonly Middleware[]): Middleware {
  return (handler) => middleware.reduceRight((next, wrap) => wrap(next), handler);
}

function requestFields(req: Request): Record<string, string> {
  return { method: req.method, path: pathOf(req) };
}

// ---------------------------------------------------------------------------
// Logging and errors
// ---------------------------------------------------------------------------

/** Logs one line per request at debug level (quiet by default). Never logs query strings. */
export function requestLogger(options: { readonly logger: Logger; readonly clock: Clock }): Middleware {
  return (next) => async (req) => {
    const started = options.clock.now();
    const response = await next(req);
    options.logger.debug("request", {
      ...requestFields(req),
      status: response.status,
      durationMs: options.clock.now() - started,
    });
    return response;
  };
}

/**
 * Turns any thrown error into a generic 500. Details (including the stack)
 * go to the server log only; the client gets an id to quote.
 */
export function errorBoundary(options: { readonly logger: Logger; readonly newId: () => string }): Middleware {
  return (next) => async (req) => {
    try {
      return await next(req);
    } catch (error) {
      const errorId = options.newId();
      options.logger.error("unhandled_error", { ...requestFields(req), errorId, error });
      return internalError(errorId);
    }
  };
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function securityHeaderValues(https: boolean): Readonly<Record<string, string>> {
  return {
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    ...(https ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

/** Adds security headers to every response that does not already set them. */
export function securityHeaders(options: { readonly trustProxy: boolean }): Middleware {
  return (next) => async (req) => {
    const response = await next(req);
    return withDefaultHeaders(response, securityHeaderValues(isHttps(req, options.trustProxy)));
  };
}

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

function timer(clock: Clock, ms: number): { readonly fired: Promise<void>; readonly cancel: Cancel } {
  let cancel: Cancel = () => {};
  const fired = new Promise<void>((resolve) => {
    cancel = clock.after(ms, resolve);
  });
  return { fired, cancel };
}

/**
 * Answers 503 if the handler has not produced a response within `ms`.
 * Streaming bodies (SSE) are unaffected once their headers are returned.
 */
export function timeout(options: { readonly ms: number; readonly clock: Clock; readonly logger: Logger }): Middleware {
  return (next) => async (req) => {
    const deadline = timer(options.clock, options.ms);
    const timedOut = deadline.fired.then(() => {
      options.logger.warn("request_timeout", { ...requestFields(req), timeoutMs: options.ms });
      return serviceUnavailable("Request timed out");
    });
    try {
      return await Promise.race([next(req), timedOut]);
    } finally {
      deadline.cancel();
    }
  };
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

export interface CorsOptions {
  /** Exact origins allowed cross-origin access. Never "*". */
  readonly allowedOrigins: readonly string[];
  readonly allowCredentials: boolean;
  readonly allowedMethods: readonly string[];
  readonly allowedHeaders: readonly string[];
  readonly exposedHeaders: readonly string[];
  readonly maxAgeSeconds: number;
  readonly logger: Logger;
}

export type OriginVerdict = "none" | "same_origin" | "allowed" | "denied";

/**
 * Classifies the request's Origin. `Sec-Fetch-Site` is set by browsers and
 * cannot be forged by page scripts, so it also identifies same-origin
 * requests when a proxy has changed the scheme or host the server sees.
 */
export function classifyOrigin(req: Request, allowedOrigins: readonly string[]): OriginVerdict {
  const origin = req.headers.get("origin");
  if (origin === null) return "none";
  if (origin === new URL(req.url).origin) return "same_origin";
  if (req.headers.get("sec-fetch-site") === "same-origin") return "same_origin";
  return allowedOrigins.includes(origin) ? "allowed" : "denied";
}

function isPreflight(req: Request): boolean {
  return req.method === "OPTIONS" && req.headers.has("access-control-request-method");
}

function credentialHeaders(allowCredentials: boolean): Readonly<Record<string, string>> {
  return allowCredentials ? { "access-control-allow-credentials": "true" } : {};
}

function preflightResponse(origin: string, options: CorsOptions): Response {
  return noContent({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": options.allowedMethods.join(", "),
    "access-control-allow-headers": options.allowedHeaders.join(", "),
    "access-control-max-age": String(options.maxAgeSeconds),
    vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    ...credentialHeaders(options.allowCredentials),
  });
}

function withCorsHeaders(response: Response, origin: string, options: CorsOptions): Response {
  return withHeaders(response, {
    "access-control-allow-origin": origin,
    "access-control-expose-headers": options.exposedHeaders.join(", "),
    vary: appendVary(response.headers.get("vary"), "Origin"),
    ...credentialHeaders(options.allowCredentials),
  });
}

/** Allowlist-based CORS. Requests from any other cross-origin page get a 403. */
export function cors(options: CorsOptions): Middleware {
  return (next) => async (req) => {
    const verdict = classifyOrigin(req, options.allowedOrigins);
    const origin = req.headers.get("origin") ?? "";
    if (verdict === "denied") {
      options.logger.warn("cors_origin_denied", { ...requestFields(req), origin: origin.slice(0, 200) });
      return forbidden("Origin not allowed");
    }
    if (verdict !== "allowed") return next(req);
    if (isPreflight(req)) return preflightResponse(origin, options);
    return withCorsHeaders(await next(req), origin, options);
  };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitOptions {
  readonly store: RateLimitStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly limit: number;
  readonly windowMs: number;
  /** The bucket a request counts against, or `null` to exempt it. */
  readonly key: (req: Request) => string | null;
}

export function secondsUntilReset(hit: RateLimitHit, now: number): number {
  return Math.max(1, Math.ceil((hit.resetAt - now) / 1000));
}

export function rateLimitHeaders(limit: number, hit: RateLimitHit, now: number): Readonly<Record<string, string>> {
  return {
    "ratelimit-limit": String(limit),
    "ratelimit-remaining": String(Math.max(0, limit - hit.count)),
    "ratelimit-reset": String(secondsUntilReset(hit, now)),
  };
}

/** Fixed-window rate limiting on top of an injected counter store. */
export function rateLimit(options: RateLimitOptions): Middleware {
  return (next) => async (req) => {
    const key = options.key(req);
    if (key === null) return next(req);
    const now = options.clock.now();
    const hit = await options.store.hit(key, options.windowMs, now);
    const headers = rateLimitHeaders(options.limit, hit, now);
    if (hit.count > options.limit) {
      options.logger.warn("rate_limited", { ...requestFields(req), key, count: hit.count, limit: options.limit });
      return withHeaders(tooManyRequests(secondsUntilReset(hit, now)), headers);
    }
    return withHeaders(await next(req), headers);
  };
}

// ---------------------------------------------------------------------------
// Body size limit
// ---------------------------------------------------------------------------

/** Parses Content-Length: `null` when absent, `"invalid"` when malformed. */
export function declaredLength(header: string | null): number | null | "invalid" {
  if (header === null) return null;
  const trimmed = header.trim();
  return /^\d{1,15}$/.test(trimmed) ? Number(trimmed) : "invalid";
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Reads a body into memory, stopping as soon as it exceeds `maxBytes` and
 * cancelling the rest so the runtime stops receiving it.
 */
export async function readLimited(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Result<Uint8Array<ArrayBuffer>, "too_large">> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { ok: true, data: concatChunks(chunks, totalBytes) };
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      // Not awaited: Bun settles a request-body cancel only once the client
      // stops sending, which would hold the 413 back until the timeout.
      reader.cancel().catch(() => {});
      return { ok: false, error: "too_large" };
    }
    chunks.push(value);
  }
}

/**
 * Rejects bodies larger than `maxBytes` before anything parses them: first by
 * Content-Length, then by counting bytes (for chunked or lying clients).
 * Downstream handlers receive a request with the body already buffered.
 */
export function bodyLimit(options: { readonly maxBytes: number; readonly logger: Logger }): Middleware {
  const reject = (req: Request, declared: number | null): Response => {
    options.logger.warn("body_too_large", { ...requestFields(req), declared, maxBytes: options.maxBytes });
    return payloadTooLarge(options.maxBytes);
  };
  return (next) => async (req) => {
    if (req.body === null || req.method === "GET" || req.method === "HEAD") return next(req);
    const declared = declaredLength(req.headers.get("content-length"));
    if (declared === "invalid") return badRequest("Invalid Content-Length header");
    if (declared !== null && declared > options.maxBytes) return reject(req, declared);
    const body = await readLimited(req.body, options.maxBytes);
    if (!body.ok) return reject(req, declared);
    return next(new Request(req, { body: body.data }));
  };
}

// ---------------------------------------------------------------------------
// Authentication hook
// ---------------------------------------------------------------------------

export type AuthResult =
  | { readonly ok: true; readonly subject: string }
  | { readonly ok: false; readonly reason: string };

/** Decides who a request is from. Implementations may use config, storage or both. */
export type Authenticate = (req: Request) => Promise<AuthResult>;

/** Lets the request through only if `authenticate` accepts it; otherwise 401. */
export function requireAuth(options: { readonly authenticate: Authenticate; readonly logger: Logger }): Middleware {
  return (next) => async (req) => {
    const result = await options.authenticate(req);
    if (result.ok) return next(req);
    options.logger.warn("auth_failed", { ...requestFields(req), reason: result.reason });
    return unauthorized();
  };
}
