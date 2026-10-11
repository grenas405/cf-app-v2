/**
 * Helpers shared by the adapters. Like the adapters, this module performs
 * side effects (wall-clock time, timers, randomness), but it uses only
 * Web-standard globals, so it is not specific to any runtime.
 */
import type { AppConfig } from "../core/config.ts";
import { errorResponse, withDefaultHeaders } from "../core/http.ts";
import { createLogger, formatLogLine } from "../core/log.ts";
import { securityHeaderValues } from "../core/middleware.ts";
import type { Clock, Deps, EventBus, LogFields, RateLimitStore, ReadStatic } from "../core/types.ts";
import { createEventBus, createMemoryRateLimitStore } from "../stores/memory.ts";
import type { UserStore } from "../users.ts";

export const systemClock: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  every: (ms, fn) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
};

export function randomId(): string {
  return crypto.randomUUID();
}

export interface PlatformDeps {
  readonly config: AppConfig;
  readonly users: UserStore;
  readonly readStatic: ReadStatic;
  /** Where log lines go (one JSON object per line). */
  readonly write: (line: string) => void;
  readonly rateLimitStore?: RateLimitStore;
  readonly events?: EventBus;
}

/** Fills in the runtime-agnostic dependencies around the platform-specific ones. */
export function createDeps(platform: PlatformDeps): Deps {
  return {
    config: platform.config,
    users: platform.users,
    readStatic: platform.readStatic,
    logger: createLogger({ level: platform.config.LOG_LEVEL, write: platform.write, now: systemClock.now }),
    clock: systemClock,
    newId: randomId,
    rateLimitStore: platform.rateLimitStore ?? createMemoryRateLimitStore(),
    events: platform.events ?? createEventBus(),
  };
}

/** An error log line for startup failures, written before any logger exists. */
export function startupErrorLine(msg: string, fields: LogFields): string {
  return formatLogLine(Date.now(), "error", msg, fields);
}

/** An error response produced by an adapter itself, outside the app's middleware. */
export function adapterErrorResponse(status: number, code: string, message: string): Response {
  return withDefaultHeaders(errorResponse(status, code, message), securityHeaderValues(false));
}

/** Last-resort response if the app itself rejects (it should not: errorBoundary catches). */
export function fallbackErrorResponse(): Response {
  return adapterErrorResponse(500, "internal_error", "Internal Server Error");
}

export function listenUrl(hostname: string, port: number): string {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `http://${host}:${port}`;
}
