/**
 * In-memory fakes for testing the app by calling it directly:
 * `await app(new Request(...))`. No server, no network, no real timers.
 */
import { createApp } from "../src/app.ts";
import { type AppConfig, parseConfig } from "../src/core/config.ts";
import { createLogger } from "../src/core/log.ts";
import type { Cancel, Clock, Deps, EventBus, Handler, KvStore, ReadStatic, ServerEvent } from "../src/core/types.ts";
import { createEventBus, createMemoryKv, createMemoryRateLimitStore } from "../src/stores/memory.ts";
import { createKvUserStore } from "../src/users.ts";

export const BASE_URL = "http://localhost:8000";
export const ADMIN_TOKEN = "test-admin-token-0123456789abcdef-XYZ";
export const START_TIME = Date.UTC(2026, 0, 1, 12, 0, 0);

export function testConfig(env: Readonly<Record<string, string>> = {}): AppConfig {
  const result = parseConfig({ LOG_LEVEL: "debug", ADMIN_TOKEN, ...env });
  if (!result.ok) throw new Error(`invalid test config: ${result.error.join("; ")}`);
  return result.data;
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface FakeClock extends Clock {
  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void;
  pendingTimers(): number;
}

interface FakeTimer {
  readonly at: number;
  readonly interval: number | null;
  readonly fn: () => void;
}

export function createFakeClock(start = START_TIME): FakeClock {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, FakeTimer>();

  const schedule = (ms: number, fn: () => void, interval: number | null): Cancel => {
    const id = nextId++;
    timers.set(id, { at: now + ms, interval, fn });
    return () => {
      timers.delete(id);
    };
  };

  const nextDue = (until: number): [number, FakeTimer] | undefined =>
    [...timers.entries()]
      .filter(([, timer]) => timer.at <= until)
      .sort(([, a], [, b]) => a.at - b.at)[0];

  return {
    now: () => now,
    after: (ms, fn) => schedule(ms, fn, null),
    every: (ms, fn) => schedule(ms, fn, ms),
    advance: (ms) => {
      const target = now + ms;
      for (let due = nextDue(target); due !== undefined; due = nextDue(target)) {
        const [id, timer] = due;
        now = timer.at;
        if (timer.interval === null) timers.delete(id);
        else timers.set(id, { ...timer, at: timer.at + timer.interval });
        timer.fn();
      }
      now = target;
    },
    pendingTimers: () => timers.size,
  };
}

// ---------------------------------------------------------------------------
// Logs, events, ids, static files
// ---------------------------------------------------------------------------

export interface LogCapture {
  readonly lines: string[];
  entries(): Record<string, unknown>[];
  messages(): unknown[];
}

export function createLogCapture(): LogCapture {
  const lines: string[] = [];
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, entries, messages: () => entries().map((entry) => entry.msg) };
}

export interface CountingBus extends EventBus {
  listenerCount(): number;
}

/** Wraps the real bus to count live subscriptions (to verify SSE cleanup). */
export function createCountingBus(): CountingBus {
  const bus = createEventBus();
  let listeners = 0;
  return {
    publish: bus.publish,
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners++;
      const unsubscribe = bus.subscribe(listener);
      let active = true;
      return () => {
        if (active) listeners--;
        active = false;
        unsubscribe();
      };
    },
    listenerCount: () => listeners,
  };
}

/** Valid v4 UUIDs: 00000000-0000-4000-8000-000000000001, …0002, … */
export function sequentialIds(): () => string {
  let counter = 0;
  return () => {
    counter++;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
  };
}

export interface FakeStatic {
  readonly readStatic: ReadStatic;
  /** Every path the app asked for, to prove rejected paths never reach the reader. */
  readonly calls: string[];
}

export function createFakeStatic(files: Readonly<Record<string, string>>): FakeStatic {
  const calls: string[] = [];
  const encoder = new TextEncoder();
  const readStatic: ReadStatic = (path) => {
    calls.push(path);
    const content = files[path];
    return Promise.resolve(content === undefined ? null : encoder.encode(content));
  };
  return { readStatic, calls };
}

export const DEFAULT_FILES: Readonly<Record<string, string>> = {
  "index.html": "<!doctype html><title>Users</title>",
  "app.js": "console.log('app');",
  "styles.css": "body{margin:0}",
  "favicon.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
};

// ---------------------------------------------------------------------------
// The app under test
// ---------------------------------------------------------------------------

export interface TestAppOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly kv?: KvStore;
  readonly files?: Readonly<Record<string, string>>;
}

export interface TestApp {
  readonly app: Handler;
  readonly deps: Deps;
  readonly clock: FakeClock;
  readonly logs: LogCapture;
  readonly bus: CountingBus;
  readonly staticFiles: FakeStatic;
}

export function createTestApp(options: TestAppOptions = {}): TestApp {
  const config = testConfig(options.env);
  const clock = createFakeClock();
  const logs = createLogCapture();
  const bus = createCountingBus();
  const staticFiles = createFakeStatic(options.files ?? DEFAULT_FILES);
  const deps: Deps = {
    config,
    users: createKvUserStore(options.kv ?? createMemoryKv()),
    rateLimitStore: createMemoryRateLimitStore(),
    logger: createLogger({ level: config.LOG_LEVEL, write: (line) => logs.lines.push(line), now: clock.now }),
    clock,
    newId: sequentialIds(),
    events: bus,
    readStatic: staticFiles.readStatic,
  };
  return { app: createApp(deps), deps, clock, logs, bus, staticFiles };
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

export function get(path: string, headers: HeadersInit = {}): Request {
  return new Request(`${BASE_URL}${path}`, { headers });
}

export function postJson(path: string, body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify(body),
  });
}

export const VALID_USER = { name: "Ada Lovelace", email: "ada@example.com" } as const;
