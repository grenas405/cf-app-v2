/**
 * End-to-end behavior of `createApp`, called directly with in-memory deps.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ADMIN_TOKEN, BASE_URL, createTestApp, get, postJson, VALID_USER } from "./helpers.ts";

const FIRST_ID = "00000000-0000-4000-8000-000000000001";
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000ff";

Deno.test("GET /health returns { ok: true }", async () => {
  const { app } = createTestApp();
  const response = await app(get("/health"));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8");
  assertEquals(await response.json(), { ok: true });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

Deno.test("POST /users creates a user that GET /users/:id then returns", async () => {
  const { app, bus } = createTestApp();
  const published: unknown[] = [];
  bus.subscribe((event) => published.push(event));

  const created = await app(postJson("/users", VALID_USER));
  assertEquals(created.status, 201);
  assertEquals(created.headers.get("location"), `/users/${FIRST_ID}`);
  const user = await created.json();
  assertEquals(user, { id: FIRST_ID, ...VALID_USER, createdAt: "2026-01-01T12:00:00.000Z" });
  assertEquals(published, [{ event: "user.created", data: user }]);

  const fetched = await app(get(`/users/${FIRST_ID}`));
  assertEquals(fetched.status, 200);
  assertEquals(await fetched.json(), user);
});

Deno.test("POST /users trims names", async () => {
  const { app } = createTestApp();
  const response = await app(postJson("/users", { name: "  Grace Hopper  ", email: "grace@example.com" }));
  assertEquals((await response.json()).name, "Grace Hopper");
});

Deno.test("POST /users answers 409 when the email is taken, ignoring case", async () => {
  const { app, bus } = createTestApp();
  let published = 0;
  bus.subscribe(() => published++);
  await (await app(postJson("/users", VALID_USER))).body?.cancel();
  const duplicate = await app(postJson("/users", { name: "Someone Else", email: "ADA@example.com" }));
  assertEquals(duplicate.status, 409);
  assertEquals(await duplicate.json(), { error: "email_taken", message: "A user with this email already exists" });
  assertEquals(published, 1);
  assertEquals((await (await app(get("/users"))).json()).users.length, 1);
});

Deno.test("deleting a user frees their email", async () => {
  const { app } = createTestApp();
  await (await app(postJson("/users", VALID_USER))).body?.cancel();
  const remove = new Request(`${BASE_URL}/users/${FIRST_ID}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assertEquals((await app(remove)).status, 204);
  const again = await app(postJson("/users", VALID_USER));
  assertEquals(again.status, 201);
  await again.body?.cancel();
});

Deno.test("GET /users lists users newest first and honors ?limit", async () => {
  const { app, clock } = createTestApp();
  for (const name of ["First", "Second", "Third"]) {
    await (await app(postJson("/users", { name, email: `${name.toLowerCase()}@example.com` }))).body?.cancel();
    clock.advance(1_000);
  }
  const all = await (await app(get("/users"))).json();
  assertEquals(all.users.map((user: { name: string }) => user.name), ["Third", "Second", "First"]);

  const limited = await (await app(get("/users?limit=2"))).json();
  assertEquals(limited.users.map((user: { name: string }) => user.name), ["Third", "Second"]);
});

Deno.test("DELETE removes a user from the list as well", async () => {
  const { app } = createTestApp();
  await (await app(postJson("/users", VALID_USER))).body?.cancel();
  const remove = new Request(`${BASE_URL}/users/${FIRST_ID}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assertEquals((await app(remove)).status, 204);
  assertEquals((await (await app(get("/users"))).json()).users, []);
});

Deno.test("GET /users/:id answers 404 for a well-formed but unknown id", async () => {
  const { app } = createTestApp();
  const response = await app(get(`/users/${UNKNOWN_ID}`));
  assertEquals(response.status, 404);
  assertEquals(await response.json(), { error: "not_found", message: "User not found" });
});

Deno.test("GET /users/:id validates the id and explains the problem", async () => {
  const { app } = createTestApp();
  const response = await app(get("/users/not-a-uuid"));
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals([body.error, body.message], ["validation_failed", "Invalid request params"]);
  assertEquals(body.issues.map((issue: { path: string; code: string }) => [issue.path, issue.code]), [
    ["id", "invalid_format"],
  ]);
});

Deno.test("POST /users answers 400 with an issue per invalid field", async () => {
  const { app } = createTestApp();
  const response = await app(postJson("/users", { name: "", email: "not-an-email" }));
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error, "validation_failed");
  const paths = body.issues.map((issue: { path: string }) => issue.path);
  assert(paths.includes("name") && paths.includes("email"), `unexpected issues: ${JSON.stringify(body.issues)}`);
  for (const issue of body.issues) assert(typeof issue.message === "string" && issue.message.length > 0);
});

Deno.test("POST /users reports an empty name as one readable issue", async () => {
  const { app } = createTestApp();
  const body = await (await app(postJson("/users", { name: "   ", email: "ada@example.com" }))).json();
  assertEquals(body.issues, [{ path: "name", code: "too_small", message: "Name is required" }]);
});

Deno.test("POST /users rejects missing fields and wrong types", async () => {
  const { app } = createTestApp();
  for (const payload of [{}, { name: "Ada" }, { name: 42, email: "ada@example.com" }, [], "text", null]) {
    const response = await app(postJson("/users", payload));
    assertEquals(response.status, 400, `payload ${JSON.stringify(payload)}`);
    assertEquals((await response.json()).error, "validation_failed");
  }
});

Deno.test("POST /users answers 415 for non-JSON and 400 for malformed JSON", async () => {
  const { app } = createTestApp();
  const form = await app(new Request(`${BASE_URL}/users`, { method: "POST", body: "name=Ada" }));
  assertEquals(form.status, 415);
  await form.body?.cancel();

  const malformed = await app(
    new Request(`${BASE_URL}/users`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
  );
  assertEquals(malformed.status, 400);
  assertEquals((await malformed.json()).error, "invalid_json");
});

Deno.test("GET /users validates query parameters with an allowlist", async () => {
  const { app } = createTestApp();
  for (const query of ["limit=0", "limit=101", "limit=abc", "limit=1&limit=2", "debug=true"]) {
    const response = await app(get(`/users?${query}`));
    assertEquals(response.status, 400, query);
    assertEquals((await response.json()).message, "Invalid request query");
  }
});

Deno.test("DELETE /users/:id requires the admin bearer token", async () => {
  const { app } = createTestApp();
  await (await app(postJson("/users", VALID_USER))).body?.cancel();
  const remove = (headers: HeadersInit) =>
    app(new Request(`${BASE_URL}/users/${FIRST_ID}`, { method: "DELETE", headers }));

  const anonymous = await remove({});
  assertEquals(anonymous.status, 401);
  await anonymous.body?.cancel();

  const wrongToken = await remove({ authorization: "Bearer not-the-admin-token" });
  assertEquals(wrongToken.status, 401);
  await wrongToken.body?.cancel();

  const admin = await remove({ authorization: `Bearer ${ADMIN_TOKEN}` });
  assertEquals(admin.status, 204);

  const gone = await app(get(`/users/${FIRST_ID}`));
  assertEquals(gone.status, 404);
  await gone.body?.cancel();
});

Deno.test("DELETE is denied for everyone when no admin token is configured", async () => {
  const { app } = createTestApp({ env: { ADMIN_TOKEN: "" } });
  const response = await app(
    new Request(`${BASE_URL}/users/${FIRST_ID}`, { method: "DELETE", headers: { authorization: "Bearer x" } }),
  );
  assertEquals(response.status, 401);
  await response.body?.cancel();
});

// ---------------------------------------------------------------------------
// Routing fallbacks
// ---------------------------------------------------------------------------

Deno.test("unknown paths answer a JSON 404", async () => {
  const { app } = createTestApp();
  const response = await app(get("/does-not-exist"));
  assertEquals(response.status, 404);
  assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8");
  await response.body?.cancel();
});

Deno.test("known paths with the wrong method answer 405", async () => {
  const { app } = createTestApp();
  const response = await app(new Request(`${BASE_URL}/health`, { method: "POST" }));
  assertEquals(response.status, 405);
  assertStringIncludes(response.headers.get("allow") ?? "", "GET");
  await response.body?.cancel();
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

Deno.test("GET / serves index.html with HTML type, no-cache and an ETag", async () => {
  const { app, staticFiles } = createTestApp();
  const response = await app(get("/"));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(response.headers.get("cache-control"), "no-cache");
  assert(/^"[0-9a-f]{32}"$/.test(response.headers.get("etag") ?? ""));
  assertStringIncludes(await response.text(), "<title>Users</title>");
  assertEquals(staticFiles.calls, ["index.html"]);
});

Deno.test("static assets get their own Content-Type and cache policy", async () => {
  const { app } = createTestApp();
  const expectations: [string, string, string][] = [
    ["/app.js", "text/javascript; charset=utf-8", "no-cache"],
    ["/styles.css", "text/css; charset=utf-8", "no-cache"],
    ["/favicon.svg", "image/svg+xml", "public, max-age=86400"],
  ];
  for (const [path, type, cache] of expectations) {
    const response = await app(get(path));
    assertEquals([response.status, response.headers.get("content-type"), response.headers.get("cache-control")], [
      200,
      type,
      cache,
    ]);
    await response.body?.cancel();
  }
});

Deno.test("static files answer 304 when If-None-Match matches", async () => {
  const { app } = createTestApp();
  const first = await app(get("/app.js"));
  const etag = first.headers.get("etag") ?? "";
  await first.body?.cancel();
  const second = await app(get("/app.js", { "if-none-match": etag }));
  assertEquals([second.status, second.body], [304, null]);
});

Deno.test("missing static files answer 404", async () => {
  const { app } = createTestApp();
  const response = await app(get("/missing.js"));
  assertEquals(response.status, 404);
  await response.body?.cancel();
});

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

async function nextMessage(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  if (done) throw new Error("stream ended");
  return decoder.decode(value);
}

Deno.test("GET /events streams ready, user.created and ping events", async () => {
  const { app, clock } = createTestApp({ env: { SSE_HEARTBEAT_MS: "5000" } });
  const response = await app(get("/events"));
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assertEquals(response.headers.get("cache-control"), "no-cache, no-transform");
  const reader = response.body!.getReader();

  assertEquals(await nextMessage(reader), "retry: 3000\nevent: ready\ndata: {}\n\n");

  await (await app(postJson("/users", VALID_USER))).body?.cancel();
  const created = await nextMessage(reader);
  assertStringIncludes(created, "event: user.created\n");
  assertStringIncludes(created, `"id":"${FIRST_ID}"`);

  clock.advance(5_000);
  assertEquals(await nextMessage(reader), 'event: ping\ndata: {"time":"2026-01-01T12:00:05.000Z"}\n\n');

  await reader.cancel();
});

Deno.test("GET /events cleans up its subscription and timer when the client disconnects", async () => {
  const { app, bus, clock } = createTestApp();
  const response = await app(get("/events"));
  const reader = response.body!.getReader();
  await nextMessage(reader);
  assertEquals([bus.listenerCount(), clock.pendingTimers()], [1, 1]);

  await reader.cancel();
  assertEquals([bus.listenerCount(), clock.pendingTimers()], [0, 0]);
});
