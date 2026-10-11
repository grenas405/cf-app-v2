/**
 * The application: routes and middleware wired into one `Handler`.
 *
 * No runtime imports and no side effects: everything that touches the outside
 * world arrives through `deps`.
 */
import { bearerTokenAuth } from "./core/auth.ts";
import {
  bodyLimit,
  compose,
  cors,
  errorBoundary,
  rateLimit,
  requestLogger,
  requireAuth,
  securityHeaders,
  timeout,
} from "./core/middleware.ts";
import { clientIp, pathOf } from "./core/request.ts";
import { createRouter, type Route } from "./core/router.ts";
import type { Deps, Handler } from "./core/types.ts";
import { eventsRoute } from "./routes/events.ts";
import { healthRoute } from "./routes/health.ts";
import { staticRoute } from "./routes/static.ts";
import { createUserRoute, deleteUserRoute, getUserRoute, listUsersRoute } from "./routes/users.ts";

/** Health checks come from load balancers in bulk; never rate-limit them. */
export function rateLimitKey(req: Request, trustProxy: boolean): string | null {
  return pathOf(req) === "/health" ? null : `ip:${clientIp(req, trustProxy)}`;
}

/** Route table: plain data. The first matching route wins, so the static catch-all is last. */
export function routes(deps: Deps): readonly Route[] {
  const adminOnly = requireAuth({ authenticate: bearerTokenAuth(deps.config.ADMIN_TOKEN), logger: deps.logger });
  return [
    { method: "GET", path: "/health", handler: healthRoute() },
    { method: "GET", path: "/users", handler: listUsersRoute(deps) },
    { method: "POST", path: "/users", handler: createUserRoute(deps) },
    { method: "GET", path: "/users/:id", handler: getUserRoute(deps) },
    { method: "DELETE", path: "/users/:id", handler: deleteUserRoute(deps), middleware: [adminOnly] },
    { method: "GET", path: "/events", handler: eventsRoute(deps) },
    { method: "GET", path: "/*", handler: staticRoute(deps) },
  ];
}

export function createApp(deps: Deps): Handler {
  const { config, logger, clock } = deps;
  const middleware = compose(
    // Outermost: every response, including errors and rejections, gets security headers.
    securityHeaders({ trustProxy: config.TRUST_PROXY }),
    // Sees the final status of every request (debug level, so quiet by default).
    requestLogger({ logger, clock }),
    // Anything thrown below becomes a generic 500; details stay in the log.
    errorBoundary({ logger, newId: deps.newId }),
    // Reject disallowed origins and answer preflights before doing any work.
    cors({
      allowedOrigins: config.CORS_ORIGINS,
      allowCredentials: config.CORS_ALLOW_CREDENTIALS,
      allowedMethods: ["GET", "POST", "DELETE"],
      allowedHeaders: ["content-type", "authorization"],
      exposedHeaders: ["location", "retry-after"],
      maxAgeSeconds: 600,
      logger,
    }),
    timeout({ ms: config.REQUEST_TIMEOUT_MS, clock, logger }),
    // Cheap counter check before the comparatively expensive body read.
    rateLimit({
      store: deps.rateLimitStore,
      clock,
      logger,
      limit: config.RATE_LIMIT_MAX,
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      key: (req) => rateLimitKey(req, config.TRUST_PROXY),
    }),
    // Innermost: bodies are size-checked before any handler parses them.
    bodyLimit({ maxBytes: config.MAX_BODY_BYTES, logger }),
  );
  return middleware(createRouter(routes(deps)));
}
