/**
 * Server-sent events: pushes bus events (e.g. `user.created`) to the browser.
 */
import { createSseStream, SSE_HEADERS } from "../core/sse.ts";
import type { Deps, RouteHandler } from "../core/types.ts";

const CLIENT_RETRY_MS = 3_000;

export function eventsRoute(deps: Pick<Deps, "clock" | "events" | "config">): RouteHandler {
  return () => {
    const stream = createSseStream({
      clock: deps.clock,
      events: deps.events,
      heartbeatMs: deps.config.SSE_HEARTBEAT_MS,
      retryMs: CLIENT_RETRY_MS,
    });
    return Promise.resolve(new Response(stream, { headers: SSE_HEADERS }));
  };
}
