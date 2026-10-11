/**
 * Structured logging as line-delimited JSON.
 *
 * `createLogger` decides *what* to write (level filter, redaction, format);
 * the injected `write` function decides *where* (stdout, stderr, a test
 * array). The core never calls `console` itself.
 */
import type { LogFields, Logger, LogLevel } from "./types.ts";

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|token|authorization|cookie|api[-_]?key|session|credential|private[-_]?key/i;

const RESERVED_KEYS = new Set(["time", "level", "msg"]);

const MAX_DEPTH = 6;

export const REDACTED = "[REDACTED]";

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly write: (line: string) => void;
  readonly now: () => number;
}

export function shouldLog(minimum: LogLevel, level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minimum];
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Returns a JSON-safe copy of `value` with sensitive keys masked. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[Truncated]";
  if (value instanceof Error) return serializeError(value, depth);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (isPlainObject(value)) return redactObject(value, depth);
  if (typeof value === "bigint") return value.toString();
  return value;
}

function redactObject(value: Readonly<Record<string, unknown>>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1);
  }
  return result;
}

function serializeError(error: Error, depth: number): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined ? {} : { cause: redact(error.cause, depth + 1) }),
  };
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** One log entry as one line of JSON. Never throws. */
export function formatLogLine(time: number, level: LogLevel, msg: string, fields: LogFields): string {
  const base = { time: new Date(time).toISOString(), level, msg };
  try {
    return JSON.stringify({ ...base, ...withoutReserved(redact(fields)) });
  } catch {
    return JSON.stringify({ ...base, logError: "fields could not be serialized" });
  }
}

function withoutReserved(fields: unknown): Record<string, unknown> {
  if (!isPlainObject(fields)) return {};
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !RESERVED_KEYS.has(key)));
}

export function createLogger(options: LoggerOptions): Logger {
  const at = (level: LogLevel) => (msg: string, fields: LogFields = {}): void => {
    if (shouldLog(options.level, level)) {
      options.write(formatLogLine(options.now(), level, msg, fields));
    }
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
