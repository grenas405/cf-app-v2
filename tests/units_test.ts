/**
 * Small units: SSE formatting, crypto, in-memory stores, response helpers.
 */
import { assertEquals } from "@std/assert";
import { constantTimeEqual, timingSafeEqual, toHex } from "../src/core/crypto.ts";
import { appendVary, withHeaders } from "../src/core/http.ts";
import { clientIp, withClientIp } from "../src/core/request.ts";
import { formatSse } from "../src/core/sse.ts";
import { createMemoryKv, createMemoryRateLimitStore, nextWindow } from "../src/stores/memory.ts";
import { newestFirstKey } from "../src/users.ts";
import { get } from "./helpers.ts";

Deno.test("formatSse writes fields and splits multi-line data", () => {
  assertEquals(formatSse({ event: "note", data: "a\nb" }), "event: note\ndata: a\ndata: b\n\n");
  assertEquals(formatSse({ retry: 3000, comment: "hi" }), ": hi\nretry: 3000\n\n");
});

Deno.test("formatSse strips line breaks from single-line fields to prevent injection", () => {
  assertEquals(formatSse({ event: "x\ndata: injected", id: "1\r\n2" }), "id: 1 2\nevent: x data: injected\n\n");
});

Deno.test("timingSafeEqual compares secrets of any length", async () => {
  assertEquals(await timingSafeEqual("token", "token"), true);
  assertEquals(await timingSafeEqual("token", "tokeN"), false);
  assertEquals(await timingSafeEqual("token", "token-longer"), false);
  assertEquals(await timingSafeEqual("", ""), true);
});

Deno.test("constantTimeEqual and toHex", () => {
  assertEquals(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
  assertEquals(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
  assertEquals(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 0])), false);
  assertEquals(toHex(new Uint8Array([0, 15, 255])), "000fff");
});

Deno.test("memory KV lists by key prefix, sorted and limited", async () => {
  const kv = createMemoryKv();
  await kv.set(["users", "b"], "2");
  await kv.set(["users", "a"], "1");
  await kv.set(["usersX", "c"], "3");
  await kv.set(["other"], "4");
  assertEquals(await kv.list(["users"], 10), [
    { key: ["users", "a"], value: "1" },
    { key: ["users", "b"], value: "2" },
  ]);
  assertEquals((await kv.list(["users"], 1)).length, 1);
  await kv.delete(["users", "a"]);
  assertEquals(await kv.get(["users", "a"]), null);
});

Deno.test("memory KV evicts the oldest entries beyond maxEntries", async () => {
  const kv = createMemoryKv({ maxEntries: 2 });
  await kv.set(["a"], "1");
  await kv.set(["b"], "2");
  await kv.set(["c"], "3");
  assertEquals([await kv.get(["a"]), await kv.get(["b"]), await kv.get(["c"])], [null, "2", "3"]);
});

Deno.test("nextWindow counts within a window and resets after it", () => {
  const first = nextWindow(undefined, 1_000, 0);
  const second = nextWindow(first, 1_000, 500);
  const reset = nextWindow(second, 1_000, 1_000);
  assertEquals([first, second, reset], [
    { count: 1, resetAt: 1_000 },
    { count: 2, resetAt: 1_000 },
    { count: 1, resetAt: 2_000 },
  ]);
});

Deno.test("memory rate-limit store keeps a bounded number of keys", async () => {
  const store = createMemoryRateLimitStore({ maxKeys: 2 });
  await store.hit("a", 1_000, 0);
  await store.hit("b", 1_000, 0);
  await store.hit("c", 1_000, 2_000); // a and b have expired and are swept
  assertEquals((await store.hit("a", 1_000, 2_000)).count, 1);
});

Deno.test("appendVary adds a value once", () => {
  assertEquals(appendVary(null, "Origin"), "Origin");
  assertEquals(appendVary("Accept-Encoding", "Origin"), "Accept-Encoding, Origin");
  assertEquals(appendVary("origin", "Origin"), "origin");
});

Deno.test("withHeaders copies the response and keeps every set-cookie", async () => {
  const headers = new Headers();
  headers.append("set-cookie", "a=1");
  headers.append("set-cookie", "b=2");
  const original = new Response("body", { status: 201, headers });
  const copy = withHeaders(original, { "x-extra": "1" });
  assertEquals(copy.status, 201);
  assertEquals(copy.headers.getSetCookie(), ["a=1", "b=2"]);
  assertEquals(copy.headers.get("x-extra"), "1");
  assertEquals(await copy.text(), "body");
});

Deno.test("withClientIp overwrites a client-supplied client-IP header", () => {
  const spoofed = get("/", { "x-client-ip": "1.1.1.1" });
  assertEquals(clientIp(withClientIp(spoofed, "203.0.113.9"), false), "203.0.113.9");
  assertEquals(clientIp(withClientIp(spoofed, undefined), false), "unknown");
});

Deno.test("clientIp uses the proxy-appended X-Forwarded-For entry only when trusted", () => {
  const req = withClientIp(get("/", { "x-forwarded-for": "6.6.6.6, 198.51.100.4" }), "10.0.0.1");
  assertEquals(clientIp(req, false), "10.0.0.1");
  assertEquals(clientIp(req, true), "198.51.100.4");
});

Deno.test("newestFirstKey sorts later users first in plain ascending key order", () => {
  const older = { id: "a", name: "A", email: "a@example.com", createdAt: "2026-01-01T00:00:00.000Z" };
  const newer = { ...older, id: "b", createdAt: "2026-01-02T00:00:00.000Z" };
  const [olderKey, newerKey] = [newestFirstKey(older).join("/"), newestFirstKey(newer).join("/")];
  assertEquals(newerKey < olderKey, true);
});
