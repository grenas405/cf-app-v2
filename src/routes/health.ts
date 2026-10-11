/**
 * Liveness check. Exempt from rate limiting (see app.ts).
 */
import { json } from "../core/http.ts";
import type { RouteHandler } from "../core/types.ts";

export function healthRoute(): RouteHandler {
  return () => Promise.resolve(json({ ok: true }));
}
