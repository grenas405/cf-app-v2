/**
 * Authenticators: functions that plug into the `requireAuth` middleware hook.
 */
import { z } from "zod";
import { timingSafeEqual } from "./crypto.ts";
import type { Authenticate } from "./middleware.ts";
import { parseHeaders } from "./validate.ts";

const BEARER_PREFIX = "Bearer ";

/** RFC 6750 token68 syntax, with a sane upper bound. */
const AuthorizationHeaderSchema = z.object({
  authorization: z.string().max(1024).regex(/^Bearer [A-Za-z0-9\-._~+/]+=*$/),
});

export function parseBearerToken(headers: Headers): string | null {
  const parsed = parseHeaders(headers, AuthorizationHeaderSchema);
  return parsed.ok ? parsed.data.authorization.slice(BEARER_PREFIX.length) : null;
}

/**
 * Accepts `Authorization: Bearer <token>` when the token equals `expected`,
 * compared in constant time. With no expected token configured, every request
 * is denied (fail closed).
 */
export function bearerTokenAuth(expected: string | undefined, subject = "admin"): Authenticate {
  return async (req) => {
    if (expected === undefined) return { ok: false, reason: "not_configured" };
    const token = parseBearerToken(req.headers);
    if (token === null) return { ok: false, reason: "missing_or_malformed_token" };
    const valid = await timingSafeEqual(token, expected);
    return valid ? { ok: true, subject } : { ok: false, reason: "invalid_token" };
  };
}
