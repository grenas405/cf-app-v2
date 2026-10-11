import { assert, assertEquals } from "@std/assert";
import { createLogger, formatLogLine, redact, REDACTED, shouldLog } from "../src/core/log.ts";

Deno.test("redact masks sensitive keys at any depth", () => {
  const input = {
    user: "ada",
    password: "hunter2",
    headers: { authorization: "Bearer abc", Cookie: "sid=1", accept: "*/*" },
    nested: [{ apiKey: "k", api_key: "k", sessionId: "s", value: 1 }],
  };
  assertEquals(redact(input), {
    user: "ada",
    password: REDACTED,
    headers: { authorization: REDACTED, Cookie: REDACTED, accept: "*/*" },
    nested: [{ apiKey: REDACTED, api_key: REDACTED, sessionId: REDACTED, value: 1 }],
  });
});

Deno.test("redact serializes errors with their stack for the server log", () => {
  const serialized = redact(new TypeError("bad")) as Record<string, unknown>;
  assertEquals([serialized.name, serialized.message], ["TypeError", "bad"]);
  assert(typeof serialized.stack === "string");
});

Deno.test("redact truncates deep or circular structures instead of failing", () => {
  const circular: Record<string, unknown> = { name: "loop" };
  circular.self = circular;
  const line = formatLogLine(0, "info", "msg", { circular });
  assert(line.includes("[Truncated]"));
});

Deno.test("formatLogLine writes one JSON object per line with time, level and msg first", () => {
  const line = formatLogLine(Date.UTC(2026, 0, 1), "warn", "rate_limited", { key: "ip:1", level: "spoofed" });
  assertEquals(line.includes("\n"), false);
  assertEquals(JSON.parse(line), { time: "2026-01-01T00:00:00.000Z", level: "warn", msg: "rate_limited", key: "ip:1" });
  assert(line.startsWith('{"time":'));
});

Deno.test("shouldLog compares levels", () => {
  assertEquals(shouldLog("info", "debug"), false);
  assertEquals(shouldLog("info", "info"), true);
  assertEquals(shouldLog("info", "error"), true);
});

Deno.test("createLogger filters by level and writes through the injected function", () => {
  const lines: string[] = [];
  const logger = createLogger({ level: "warn", write: (line) => lines.push(line), now: () => 0 });
  logger.debug("hidden");
  logger.info("hidden");
  logger.warn("shown", { token: "secret" });
  logger.error("shown");
  assertEquals(lines.map((line) => JSON.parse(line).msg), ["shown", "shown"]);
  assertEquals(JSON.parse(lines[0] ?? "{}").token, REDACTED);
});
