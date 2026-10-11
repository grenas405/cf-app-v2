import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { bearerTokenAuth } from "../src/core/auth.ts";
import { json, text } from "../src/core/http.ts";
import { createLogger } from "../src/core/log.ts";
import {
  bodyLimit,
  classifyOrigin,
  compose,
  CONTENT_SECURITY_POLICY,
  cors,
  type CorsOptions,
  declaredLength,
  errorBoundary,
  rateLimit,
  requestLogger,
  requireAuth,
  securityHeaders,
  timeout,
} from "../src/core/middleware.ts";
import type { Handler, Middleware } from "../src/core/types.ts";
import { createMemoryRateLimitStore } from "../src/stores/memory.ts";
import { BASE_URL, createFakeClock, createLogCapture, get } from "./helpers.ts";

const ok: Handler = () => Promise.resolve(text("ok"));

function capturedLogger() {
  const logs = createLogCapture();
  const logger = createLogger({ level: "debug", write: (line) => logs.lines.push(line), now: () => 0 });
  return { logs, logger };
}

// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------

Deno.test("compose runs middleware outermost-first, then unwinds", async () => {
  const order: string[] = [];
  const record = (name: string): Middleware => (next) => async (req) => {
    order.push(`${name}:before`);
    const response = await next(req);
    order.push(`${name}:after`);
    return response;
  };
  const handler: Handler = () => {
    order.push("handler");
    return Promise.resolve(text("done"));
  };
  await (await compose(record("a"), record("b"), record("c"))(handler)(get("/"))).body?.cancel();
  assertEquals(order, ["a:before", "b:before", "c:before", "handler", "c:after", "b:after", "a:after"]);
});

Deno.test("compose with no middleware returns the handler unchanged", () => {
  assertEquals(compose()(ok), ok);
});

Deno.test("a middleware can short-circuit so inner layers never run", async () => {
  let innerRan = false;
  const stop: Middleware = () => () => Promise.resolve(text("stopped", { status: 418 }));
  const inner: Middleware = (next) => (req) => {
    innerRan = true;
    return next(req);
  };
  const response = await compose(stop, inner)(ok)(get("/"));
  assertEquals([response.status, innerRan], [418, false]);
  await response.body?.cancel();
});

// ---------------------------------------------------------------------------
// errorBoundary and requestLogger
// ---------------------------------------------------------------------------

Deno.test("errorBoundary returns a generic 500 and logs the details", async () => {
  const { logs, logger } = capturedLogger();
  const failing: Handler = () => Promise.reject(new Error("db password=hunter2 exploded"));
  const response = await errorBoundary({ logger, newId: () => "err-1" })(failing)(get("/boom"));
  const body = await response.text();
  assertEquals(response.status, 500);
  assertEquals(JSON.parse(body), { error: "internal_error", message: "Internal Server Error", errorId: "err-1" });
  assertEquals(body.includes("hunter2") || body.includes("stack"), false);
  const [entry] = logs.entries();
  assertEquals([entry?.msg, entry?.errorId, entry?.path], ["unhandled_error", "err-1", "/boom"]);
  assertStringIncludes(JSON.stringify(entry?.error), "exploded");
});

Deno.test("requestLogger writes one debug line without the query string", async () => {
  const { logs, logger } = capturedLogger();
  const clock = createFakeClock();
  await (await requestLogger({ logger, clock })(ok)(get("/users?token=abc"))).body?.cancel();
  const [entry] = logs.entries();
  assertEquals([entry?.level, entry?.msg, entry?.path, entry?.status], ["debug", "request", "/users", 200]);
  assertEquals(logs.lines[0]?.includes("abc"), false);
});

// ---------------------------------------------------------------------------
// securityHeaders
// ---------------------------------------------------------------------------

Deno.test("securityHeaders adds CSP, nosniff, referrer and framing headers", async () => {
  const response = await securityHeaders({ trustProxy: false })(ok)(get("/"));
  assertEquals(response.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(response.headers.get("referrer-policy"), "no-referrer");
  assertEquals(response.headers.get("x-frame-options"), "DENY");
  assertStringIncludes(CONTENT_SECURITY_POLICY, "frame-ancestors 'none'");
  assertEquals(response.headers.get("strict-transport-security"), null);
  await response.body?.cancel();
});

Deno.test("securityHeaders adds HSTS only over HTTPS", async () => {
  const https = await securityHeaders({ trustProxy: false })(ok)(new Request("https://example.com/"));
  assertStringIncludes(https.headers.get("strict-transport-security") ?? "", "max-age=");
  await https.body?.cancel();
});

Deno.test("securityHeaders trusts X-Forwarded-Proto only when configured", async () => {
  const forwarded = () => get("/", { "x-forwarded-proto": "https" });
  const untrusted = await securityHeaders({ trustProxy: false })(ok)(forwarded());
  const trusted = await securityHeaders({ trustProxy: true })(ok)(forwarded());
  assertEquals(untrusted.headers.has("strict-transport-security"), false);
  assertEquals(trusted.headers.has("strict-transport-security"), true);
  await untrusted.body?.cancel();
  await trusted.body?.cancel();
});

Deno.test("securityHeaders keeps headers a handler set itself", async () => {
  const custom: Handler = () => Promise.resolve(text("x", { headers: { "referrer-policy": "same-origin" } }));
  const response = await securityHeaders({ trustProxy: false })(custom)(get("/"));
  assertEquals(response.headers.get("referrer-policy"), "same-origin");
  await response.body?.cancel();
});

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------

Deno.test("timeout answers 503 when the handler is too slow", async () => {
  const { logs, logger } = capturedLogger();
  const clock = createFakeClock();
  const never: Handler = () => new Promise(() => {});
  const pending = timeout({ ms: 1_000, clock, logger })(never)(get("/slow"));
  clock.advance(1_000);
  const response = await pending;
  assertEquals(response.status, 503);
  assertEquals(logs.messages(), ["request_timeout"]);
  await response.body?.cancel();
});

Deno.test("timeout cancels its timer when the handler finishes first", async () => {
  const { logger } = capturedLogger();
  const clock = createFakeClock();
  const response = await timeout({ ms: 1_000, clock, logger })(ok)(get("/"));
  assertEquals([response.status, clock.pendingTimers()], [200, 0]);
  await response.body?.cancel();
});

// ---------------------------------------------------------------------------
// cors
// ---------------------------------------------------------------------------

function corsOptions(overrides: Partial<CorsOptions> = {}): CorsOptions {
  return {
    allowedOrigins: ["https://app.example"],
    allowCredentials: false,
    allowedMethods: ["GET", "POST"],
    allowedHeaders: ["content-type"],
    exposedHeaders: ["location"],
    maxAgeSeconds: 600,
    logger: capturedLogger().logger,
    ...overrides,
  };
}

Deno.test("classifyOrigin distinguishes none, same-origin, allowed and denied", () => {
  const allowed = ["https://app.example"];
  assertEquals(classifyOrigin(get("/"), allowed), "none");
  assertEquals(classifyOrigin(get("/", { origin: BASE_URL }), allowed), "same_origin");
  assertEquals(
    classifyOrigin(get("/", { origin: "https://proxy.example", "sec-fetch-site": "same-origin" }), allowed),
    "same_origin",
  );
  assertEquals(classifyOrigin(get("/", { origin: "https://app.example" }), allowed), "allowed");
  assertEquals(classifyOrigin(get("/", { origin: "https://evil.example" }), allowed), "denied");
  assertEquals(classifyOrigin(get("/", { origin: "null" }), allowed), "denied");
});

Deno.test("cors adds headers for allowed origins and never uses a wildcard", async () => {
  const response = await cors(corsOptions({ allowCredentials: true }))(ok)(get("/", { origin: "https://app.example" }));
  assertEquals(response.headers.get("access-control-allow-origin"), "https://app.example");
  assertEquals(response.headers.get("access-control-allow-credentials"), "true");
  assertEquals(response.headers.get("vary"), "Origin");
  await response.body?.cancel();
});

Deno.test("cors blocks disallowed origins with 403 and logs it", async () => {
  const { logs, logger } = capturedLogger();
  let handlerRan = false;
  const handler: Handler = () => {
    handlerRan = true;
    return ok(get("/"));
  };
  const response = await cors(corsOptions({ logger }))(handler)(get("/", { origin: "https://evil.example" }));
  assertEquals([response.status, handlerRan], [403, false]);
  assertEquals(response.headers.has("access-control-allow-origin"), false);
  assertEquals(logs.messages(), ["cors_origin_denied"]);
  await response.body?.cancel();
});

Deno.test("cors answers preflights from allowed origins", async () => {
  const preflight = new Request(`${BASE_URL}/users`, {
    method: "OPTIONS",
    headers: { origin: "https://app.example", "access-control-request-method": "POST" },
  });
  const response = await cors(corsOptions())(ok)(preflight);
  assertEquals(response.status, 204);
  assertEquals(response.headers.get("access-control-allow-methods"), "GET, POST");
  assertEquals(response.headers.get("access-control-allow-headers"), "content-type");
});

Deno.test("cors leaves same-origin and origin-less requests untouched", async () => {
  for (const req of [get("/"), get("/", { origin: BASE_URL })]) {
    const response = await cors(corsOptions())(ok)(req);
    assertEquals([response.status, response.headers.has("access-control-allow-origin")], [200, false]);
    await response.body?.cancel();
  }
});

// ---------------------------------------------------------------------------
// rateLimit
// ---------------------------------------------------------------------------

Deno.test("rateLimit allows `limit` requests per window, then answers 429", async () => {
  const { logs, logger } = capturedLogger();
  const clock = createFakeClock();
  const limited = rateLimit({
    store: createMemoryRateLimitStore(),
    clock,
    logger,
    limit: 2,
    windowMs: 60_000,
    key: () => "client",
  })(ok);
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const response = await limited(get("/"));
    statuses.push(response.status);
    if (i === 2) {
      assertEquals(response.headers.get("retry-after"), "60");
      assertEquals(response.headers.get("ratelimit-remaining"), "0");
    }
    await response.body?.cancel();
  }
  assertEquals(statuses, [200, 200, 429]);
  assertEquals(logs.messages(), ["rate_limited"]);

  clock.advance(60_000);
  const afterWindow = await limited(get("/"));
  assertEquals(afterWindow.status, 200);
  await afterWindow.body?.cancel();
});

Deno.test("rateLimit skips requests whose key is null", async () => {
  const limited = rateLimit({
    store: createMemoryRateLimitStore(),
    clock: createFakeClock(),
    logger: capturedLogger().logger,
    limit: 1,
    windowMs: 60_000,
    key: () => null,
  })(ok);
  for (let i = 0; i < 3; i++) {
    const response = await limited(get("/"));
    assertEquals(response.status, 200);
    assertEquals(response.headers.has("ratelimit-limit"), false);
    await response.body?.cancel();
  }
});

// ---------------------------------------------------------------------------
// bodyLimit
// ---------------------------------------------------------------------------

const echoBody: Handler = async (req) => text(await req.text());

function post(body: BodyInit, headers: HeadersInit = {}): Request {
  return new Request(`${BASE_URL}/`, { method: "POST", body, headers });
}

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return ReadableStream.from(chunks.map((chunk) => encoder.encode(chunk)));
}

Deno.test("declaredLength parses Content-Length strictly", () => {
  assertEquals(declaredLength(null), null);
  assertEquals(declaredLength("42"), 42);
  assertEquals(declaredLength("-1"), "invalid");
  assertEquals(declaredLength("1e3"), "invalid");
  assertEquals(declaredLength("12, 12"), "invalid");
});

Deno.test("bodyLimit passes small bodies through intact", async () => {
  const response = await bodyLimit({ maxBytes: 10, logger: capturedLogger().logger })(echoBody)(post("hello"));
  assertEquals([response.status, await response.text()], [200, "hello"]);
});

Deno.test("bodyLimit rejects a declared oversized body before reading it", async () => {
  const { logs, logger } = capturedLogger();
  let handlerRan = false;
  const handler: Handler = () => {
    handlerRan = true;
    return ok(get("/"));
  };
  const response = await bodyLimit({ maxBytes: 10, logger })(handler)(post("x".repeat(11), { "content-length": "11" }));
  assertEquals([response.status, handlerRan], [413, false]);
  assertEquals(logs.messages(), ["body_too_large"]);
  await response.body?.cancel();
});

Deno.test("bodyLimit counts bytes when Content-Length is missing or wrong", async () => {
  const limit = bodyLimit({ maxBytes: 10, logger: capturedLogger().logger })(echoBody);
  const chunked = await limit(post(streamOf(["123456", "789012"])));
  const lying = await limit(post(streamOf(["123456", "789012"]), { "content-length": "3" }));
  assertEquals([chunked.status, lying.status], [413, 413]);
  await chunked.body?.cancel();
  await lying.body?.cancel();
});

Deno.test("bodyLimit rejects a malformed Content-Length", async () => {
  const response = await bodyLimit({ maxBytes: 10, logger: capturedLogger().logger })(echoBody)(
    post("hi", { "content-length": "abc" }),
  );
  assertEquals(response.status, 400);
  await response.body?.cancel();
});

// ---------------------------------------------------------------------------
// requireAuth + bearerTokenAuth
// ---------------------------------------------------------------------------

const SECRET = "s3cret-token-with-enough-length-1234567";

Deno.test("requireAuth lets a valid bearer token through", async () => {
  const guarded = requireAuth({ authenticate: bearerTokenAuth(SECRET), logger: capturedLogger().logger })(ok);
  const response = await guarded(get("/", { authorization: `Bearer ${SECRET}` }));
  assertEquals(response.status, 200);
  await response.body?.cancel();
});

Deno.test("requireAuth answers 401 and logs the reason, never the token", async () => {
  const { logs, logger } = capturedLogger();
  const guarded = requireAuth({ authenticate: bearerTokenAuth(SECRET), logger })(ok);
  const cases: [HeadersInit, string][] = [
    [{}, "missing_or_malformed_token"],
    [{ authorization: "Basic abc" }, "missing_or_malformed_token"],
    [{ authorization: "Bearer wrong-token-value" }, "invalid_token"],
  ];
  for (const [headers] of cases) {
    const response = await guarded(get("/", headers));
    assertEquals(response.status, 401);
    assertEquals(response.headers.get("www-authenticate"), 'Bearer realm="api"');
    await response.body?.cancel();
  }
  assertEquals(logs.entries().map((entry) => entry.reason), cases.map(([, reason]) => reason));
  assertEquals(logs.lines.join("\n").includes("wrong-token-value"), false);
});

Deno.test("bearerTokenAuth fails closed when no token is configured", async () => {
  const result = await bearerTokenAuth(undefined)(get("/", { authorization: "Bearer anything" }));
  assertEquals(result, { ok: false, reason: "not_configured" });
});

Deno.test("json helper and middleware keep explicit content types", async () => {
  const response = await securityHeaders({ trustProxy: false })(() => Promise.resolve(json({ a: 1 })))(get("/"));
  assert(response.headers.get("content-type")?.startsWith("application/json"));
  await response.body?.cancel();
});
