/**
 * In-memory implementations of the storage interfaces. They hold state, so
 * they are built by adapters (or tests) and injected; the core never creates
 * them. Built only on Web-standard JavaScript, so every runtime can use them.
 *
 * Data lives in one process (one isolate on Workers) and is lost on restart.
 */
import type { EventBus, KvEntry, KvKey, KvStore, RateLimitHit, RateLimitStore, ServerEvent } from "../core/types.ts";

function encodeKey(key: KvKey): string {
  return JSON.stringify(key);
}

function hasPrefix(key: KvKey, prefix: KvKey): boolean {
  return prefix.length <= key.length && prefix.every((part, index) => key[index] === part);
}

/** Deletes the oldest entries (Map keeps insertion order) until at most `max` remain. */
function evictOldest<V>(map: Map<string, V>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) return;
    map.delete(key);
  }
}

export interface MemoryKvOptions {
  /** Oldest entries are evicted beyond this many, bounding memory use. */
  readonly maxEntries: number;
}

export function createMemoryKv(options: MemoryKvOptions = { maxEntries: 10_000 }): KvStore {
  const entries = new Map<string, KvEntry>();
  const store = (key: KvKey, value: string): void => {
    const encoded = encodeKey(key);
    entries.delete(encoded);
    entries.set(encoded, { key: [...key], value });
    evictOldest(entries, options.maxEntries);
  };
  return {
    get: (key) => Promise.resolve(entries.get(encodeKey(key))?.value ?? null),
    set: (key, value) => {
      store(key, value);
      return Promise.resolve();
    },
    // Check and write happen in one synchronous step, so this is atomic.
    setIfAbsent: (key, value) => {
      if (entries.has(encodeKey(key))) return Promise.resolve(false);
      store(key, value);
      return Promise.resolve(true);
    },
    delete: (key) => {
      entries.delete(encodeKey(key));
      return Promise.resolve();
    },
    list: (prefix, limit) => {
      const matches = [...entries.entries()]
        .filter(([, entry]) => hasPrefix(entry.key, prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, limit)
        .map(([, entry]) => entry);
      return Promise.resolve(matches);
    },
  };
}

export interface MemoryRateLimitOptions {
  /** Expired windows are swept, then the oldest evicted, beyond this many keys. */
  readonly maxKeys: number;
}

/** Pure: the next state of one fixed window after a hit at `now`. */
export function nextWindow(current: RateLimitHit | undefined, windowMs: number, now: number): RateLimitHit {
  if (current !== undefined && current.resetAt > now) {
    return { count: current.count + 1, resetAt: current.resetAt };
  }
  return { count: 1, resetAt: now + windowMs };
}

export function createMemoryRateLimitStore(
  options: MemoryRateLimitOptions = { maxKeys: 50_000 },
): RateLimitStore {
  const windows = new Map<string, RateLimitHit>();
  const sweep = (now: number): void => {
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
    evictOldest(windows, options.maxKeys);
  };
  return {
    hit: (key, windowMs, now) => {
      const next = nextWindow(windows.get(key), windowMs, now);
      windows.set(key, next);
      if (windows.size > options.maxKeys) sweep(now);
      return Promise.resolve(next);
    },
  };
}

export function createEventBus(): EventBus {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    publish: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
