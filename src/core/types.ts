/**
 * Shared types for the runtime-agnostic core.
 *
 * Everything that performs a side effect (storage, logging, time, randomness,
 * file reads) is described here as an interface and handed to the app through
 * `Deps`. Adapters build the real implementations; tests build fakes.
 */
import type { AppConfig } from "./config.ts";

/** The whole application, and every piece of it, has this shape. */
export type Handler = (req: Request) => Promise<Response>;

/** Wraps a handler to add behavior before and/or after it. */
export type Middleware = (next: Handler) => Handler;

/** Named path parameters captured by the router, e.g. `{ id: "…" }`. */
export type Params = Readonly<Record<string, string>>;

/** A route handler receives the request plus its matched path parameters. */
export type RouteHandler = (req: Request, params: Params) => Promise<Response>;

/** Cancels a timer or a subscription. Safe to call more than once. */
export type Cancel = () => void;

/** An outcome returned as data instead of thrown. */
export type Result<T, E> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: E };

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Keys are tuples of strings, e.g. `["users", id]`. */
export type KvKey = readonly string[];

export interface KvEntry {
  readonly key: KvKey;
  readonly value: string;
}

/** Minimal key-value storage. Values are strings (usually JSON). */
export interface KvStore {
  get(key: KvKey): Promise<string | null>;
  set(key: KvKey, value: string): Promise<void>;
  delete(key: KvKey): Promise<void>;
  /** Up to `limit` entries whose key starts with `prefix`. */
  list(prefix: KvKey, limit: number): Promise<readonly KvEntry[]>;
}

export interface RateLimitHit {
  /** Hits counted in the current window, including this one. */
  readonly count: number;
  /** Epoch milliseconds when the current window ends. */
  readonly resetAt: number;
}

/** Counter storage for fixed-window rate limiting. */
export interface RateLimitStore {
  /** Records one hit for `key` and returns the window's running total. */
  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
}

// ---------------------------------------------------------------------------
// Time, logging, events, files
// ---------------------------------------------------------------------------

export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
  /** Runs `fn` once after `ms`. */
  after(ms: number, fn: () => void): Cancel;
  /** Runs `fn` every `ms` until cancelled. */
  every(ms: number, fn: () => void): Cancel;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** An event that can be pushed to clients over server-sent events. */
export interface ServerEvent {
  readonly event: string;
  readonly data: unknown;
}

export interface EventBus {
  publish(event: ServerEvent): void;
  subscribe(listener: (event: ServerEvent) => void): Cancel;
}

/**
 * Reads a file from the static root. `path` is already sanitized and relative
 * (e.g. `"index.html"`). Resolves to `null` when the file does not exist.
 */
export type ReadStatic = (path: string) => Promise<Uint8Array<ArrayBuffer> | null>;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Everything the app needs from the outside world. */
export interface Deps {
  readonly config: AppConfig;
  readonly kv: KvStore;
  readonly rateLimitStore: RateLimitStore;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly events: EventBus;
  readonly readStatic: ReadStatic;
}
