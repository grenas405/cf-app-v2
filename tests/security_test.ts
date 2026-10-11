/**
 * Security behavior of the whole app (OWASP-oriented), driven through
 * `app(new Request(...))` with in-memory deps.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { KvStore } from "../src/core/types.ts";
import { createMemoryKv } from "../src/stores/memory.ts";
import { ADMIN_TOKEN, BASE_URL, createTestApp, get, postJson, VALID_USER } from "./helpers.ts";

const ALLOWED_ORIGIN = "https://app.example";
const EVIL_ORIGIN = "https://evil.example";

async function drain(response: Response): Promise<Response> {
  await response.body?.cancel();
  return response;
}

async function userCount(app: (req: Request) => Promise<Response>): Promise<number> {
  return (await (await app(get("/users"))).json()).users.length;
}

// ---------------------------------------------------------------------------
// Request size and shape
// ---------------------------------------------------------------------------

Deno.test("oversized bodies are rejected with 413 before validation", async () => {
  const { app, logs } = createTestApp({ env: { MAX_BODY_BYTES: "256" } });
  const big = { name: "A".repeat(50), email: `${"a".repeat(300)}@example.com` };

  const response = await app(postJson("/users", big));
  assertEquals(response.status, 413);
  assertEquals((await response.json()).error, "payload_too_large");
  assertEquals(await userCount(app), 0);
  const messages = logs.messages();
  assert(messages.includes("body_too_large"));
  assert(!messages.includes("validation_failed"), "the body must never reach the validator");
});

Deno.test("oversized bodies are rejected by Content-Length without reading them", async () => {
  const { app } = createTestApp({ env: { MAX_BODY_BYTES: "256" } });
  const response = await app(
    new Request(`${BASE_URL}/users`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1000000" },
      body: "{}",
    }),
  );
  assertEquals((await drain(response)).status, 413);
});

Deno.test("unknown fields are rejected and nothing is stored", async () => {
  const { app } = createTestApp();
  const response = await app(postJson("/users", { ...VALID_USER, role: "admin", id: "chosen-by-client" }));
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.issues[0].code, "unrecognized_keys");
  assertEquals(await userCount(app), 0);
});

Deno.test("names outside the allowlist (markup, control characters) are rejected", async () => {
  const { app } = createTestApp();
  for (const name of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "Ada\u0000", "Ada\nLovelace"]) {
    const response = await app(postJson("/users", { name, email: "x@example.com" }));
    assertEquals(response.status, 400, JSON.stringify(name));
    assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8");
    await response.body?.cancel();
  }
  assertEquals(await userCount(app), 0);
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

Deno.test("requests from disallowed origins are blocked", async () => {
  const { app, logs } = createTestApp({ env: { CORS_ORIGINS: ALLOWED_ORIGIN } });

  const simple = await app(postJson("/users", VALID_USER, { origin: EVIL_ORIGIN }));
  assertEquals(simple.status, 403);
  assertEquals(simple.headers.has("access-control-allow-origin"), false);
  await simple.body?.cancel();

  const preflight = await app(
    new Request(`${BASE_URL}/users`, {
      method: "OPTIONS",
      headers: { origin: EVIL_ORIGIN, "access-control-request-method": "POST" },
    }),
  );
  assertEquals(preflight.status, 403);
  await preflight.body?.cancel();

  assertEquals(await userCount(app), 0);
  assertEquals(logs.messages().filter((msg) => msg === "cors_origin_denied").length, 2);
});

Deno.test("allowed origins get exact (non-wildcard) CORS headers", async () => {
  const { app } = createTestApp({ env: { CORS_ORIGINS: ALLOWED_ORIGIN, CORS_ALLOW_CREDENTIALS: "true" } });
  const response = await drain(await app(postJson("/users", VALID_USER, { origin: ALLOWED_ORIGIN })));
  assertEquals(response.status, 201);
  assertEquals(response.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
  assertEquals(response.headers.get("access-control-allow-credentials"), "true");
  assertStringIncludes(response.headers.get("vary") ?? "", "Origin");
});

Deno.test("the app's own origin is always allowed (the bundled frontend works)", async () => {
  const { app } = createTestApp();
  const response = await drain(await app(postJson("/users", VALID_USER, { origin: BASE_URL })));
  assertEquals(response.status, 201);
});

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

Deno.test("security headers are present on every kind of response", async () => {
  const brokenKv: KvStore = { ...createMemoryKv(), list: () => Promise.reject(new Error("boom")) };
  const { app } = createTestApp({ kv: brokenKv });
  const requests: [string, Request][] = [
    ["json", get("/health")],
    ["html", get("/")],
    ["404", get("/nope")],
    ["400", get("/users/nope")],
    ["405", new Request(`${BASE_URL}/health`, { method: "PUT" })],
    ["500", get("/users")],
    ["sse", get("/events")],
  ];
  for (const [label, req] of requests) {
    const response = await drain(await app(req));
    assertStringIncludes(response.headers.get("content-security-policy") ?? "", "default-src 'self'", label);
    assertEquals(response.headers.get("x-content-type-options"), "nosniff", label);
    assertEquals(response.headers.get("referrer-policy"), "no-referrer", label);
    assertEquals(response.headers.get("x-frame-options"), "DENY", label);
  }
});

Deno.test("the CSP forbids inline scripts and styles", async () => {
  const { app } = createTestApp();
  const csp = (await drain(await app(get("/")))).headers.get("content-security-policy") ?? "";
  assertStringIncludes(csp, "script-src 'self'");
  assertStringIncludes(csp, "style-src 'self'");
  assertEquals(csp.includes("unsafe-inline") || csp.includes("unsafe-eval"), false);
});

Deno.test("HSTS is sent over HTTPS only", async () => {
  const { app } = createTestApp();
  const http = await drain(await app(get("/health")));
  const https = await drain(await app(new Request("https://example.com/health")));
  assertEquals(http.headers.has("strict-transport-security"), false);
  assertEquals(https.headers.has("strict-transport-security"), true);
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

Deno.test("rate limiting triggers after RATE_LIMIT_MAX requests per client", async () => {
  const { app, logs } = createTestApp({ env: { RATE_LIMIT_MAX: "3", RATE_LIMIT_WINDOW_MS: "60000" } });
  const client = { "x-client-ip": "203.0.113.7" };
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await drain(await app(get("/users", client)))).status);
  assertEquals(statuses, [200, 200, 200, 429]);

  const limited = await app(get("/users", client));
  assertEquals(limited.headers.get("retry-after"), "60");
  assertEquals((await limited.json()).error, "rate_limited");
  assert(logs.messages().includes("rate_limited"));

  const otherClient = await drain(await app(get("/users", { "x-client-ip": "203.0.113.8" })));
  assertEquals(otherClient.status, 200);
});

Deno.test("rate limiting ignores X-Forwarded-For unless TRUST_PROXY is set", async () => {
  const { app } = createTestApp({ env: { RATE_LIMIT_MAX: "1" } });
  const spoof = (forwardedFor: string) =>
    get("/users", { "x-client-ip": "203.0.113.7", "x-forwarded-for": forwardedFor });
  assertEquals((await drain(await app(spoof("198.51.100.1")))).status, 200);
  assertEquals((await drain(await app(spoof("198.51.100.2")))).status, 429);
});

Deno.test("health checks are exempt from rate limiting", async () => {
  const { app } = createTestApp({ env: { RATE_LIMIT_MAX: "1" } });
  for (let i = 0; i < 5; i++) assertEquals((await drain(await app(get("/health")))).status, 200);
});

Deno.test("middleware order: rejected origins do not consume the rate limit", async () => {
  const { app } = createTestApp({ env: { RATE_LIMIT_MAX: "1", CORS_ORIGINS: ALLOWED_ORIGIN } });
  for (let i = 0; i < 3; i++) await drain(await app(get("/users", { origin: EVIL_ORIGIN })));
  assertEquals((await drain(await app(get("/users")))).status, 200);
});

Deno.test("middleware order: a 429 still carries security, rate-limit and CORS headers", async () => {
  const { app } = createTestApp({ env: { RATE_LIMIT_MAX: "1", CORS_ORIGINS: ALLOWED_ORIGIN } });
  await drain(await app(get("/users", { origin: ALLOWED_ORIGIN })));
  const limited = await drain(await app(get("/users", { origin: ALLOWED_ORIGIN })));
  assertEquals(limited.status, 429);
  assertEquals(limited.headers.get("x-content-type-options"), "nosniff");
  assertEquals(limited.headers.get("ratelimit-remaining"), "0");
  assertEquals(limited.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
});

Deno.test("middleware order: the request log line comes after the handler's own events", async () => {
  const { app, logs } = createTestApp();
  await drain(await app(postJson("/users", { name: "", email: "x" })));
  assertEquals(logs.messages(), ["validation_failed", "request"]);
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const TRAVERSAL_ATTEMPTS = [
  "/..%2f..%2fetc%2fpasswd",
  "/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "/static/..%2F..%2Fsecret",
  "/..%5c..%5cwindows%5cwin.ini",
  "//etc/passwd",
  "/.env",
  "/.git/config",
  "/index.html%00.js",
  "/C:%5cWindows",
  "/%E0%A4%A",
];

Deno.test("path traversal attempts on static routes are rejected before any file read", async () => {
  const { app, staticFiles, logs } = createTestApp();
  for (const path of TRAVERSAL_ATTEMPTS) {
    const response = await app(get(path));
    assertEquals(response.status, 400, path);
    assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8", path);
    await response.body?.cancel();
  }
  assertEquals(staticFiles.calls, [], "the file reader must never see a rejected path");
  assertEquals(logs.messages().filter((msg) => msg === "static_path_rejected").length, TRAVERSAL_ATTEMPTS.length);
});

Deno.test("dot segments normalized by the URL parser stay inside the static root", async () => {
  const { app, staticFiles } = createTestApp();
  await drain(await app(get("/../../etc/passwd")));
  assertEquals(staticFiles.calls, ["etc/passwd"]);
});

// ---------------------------------------------------------------------------
// Errors and secrets
// ---------------------------------------------------------------------------

Deno.test("500 responses contain no stack trace or internal message", async () => {
  const secret = "postgres://admin:hunter2@db.internal:5432";
  const brokenKv: KvStore = {
    ...createMemoryKv(),
    get: () => Promise.reject(new Error(`connect failed: ${secret}`)),
  };
  const { app, logs } = createTestApp({ kv: brokenKv });

  const response = await app(get("/users/00000000-0000-4000-8000-000000000001"));
  assertEquals(response.status, 500);
  const body = await response.text();
  assertEquals(JSON.parse(body), {
    error: "internal_error",
    message: "Internal Server Error",
    errorId: "00000000-0000-4000-8000-000000000001",
  });
  for (const leak of ["hunter2", "stack", "    at ", "connect failed", ".ts:"]) {
    assertEquals(body.includes(leak), false, `response leaked ${JSON.stringify(leak)}`);
  }

  const logged = logs.entries().find((entry) => entry.msg === "unhandled_error");
  assertStringIncludes(JSON.stringify(logged?.error), "stack");
});

Deno.test("secrets and credentials never appear in logs", async () => {
  const { app, logs } = createTestApp();
  const id = "00000000-0000-4000-8000-000000000001";
  await drain(await app(postJson("/users", VALID_USER)));
  const attempts = [`Bearer ${ADMIN_TOKEN}x`, `Bearer ${ADMIN_TOKEN}`];
  for (const authorization of attempts) {
    await drain(
      await app(
        new Request(`${BASE_URL}/users/${id}`, { method: "DELETE", headers: { authorization, cookie: "sid=abc" } }),
      ),
    );
  }
  const output = logs.lines.join("\n");
  assert(logs.lines.length > 0);
  assertEquals(output.includes(ADMIN_TOKEN), false);
  assertEquals(output.includes("sid=abc"), false);
});

Deno.test("user input is never reflected into HTML", async () => {
  const { app } = createTestApp();
  const response = await app(get("/%3Cscript%3Ealert(1)%3C%2Fscript%3E"));
  assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8");
  assertEquals((await response.text()).includes("<script>"), false);
});
