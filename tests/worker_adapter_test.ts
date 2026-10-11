/**
 * The Workers adapter has no import-time side effects, so it can be exercised
 * here with fake bindings: D1 on in-memory SQLite, and a stub ASSETS fetcher.
 */
import { assertEquals } from "@std/assert";
import worker, { createD1UserStore, type Env } from "../src/adapters/worker.ts";
import type { User } from "../src/users.ts";
import { createSqliteD1 } from "./d1_sqlite.ts";
import { ADMIN_TOKEN } from "./helpers.ts";

function fakeEnv(vars: Readonly<Record<string, unknown>> = {}): Env {
  return {
    DB: createSqliteD1(),
    ASSETS: {
      fetch: (req) =>
        Promise.resolve(
          new URL(req.url).pathname === "/index.html"
            ? new Response("<!doctype html><title>Users</title>")
            : new Response("Not Found", { status: 404 }),
        ),
    },
    LOG_LEVEL: "error",
    ADMIN_TOKEN,
    ...vars,
  };
}

function createRequest(name: string, email: string): Request {
  return new Request("https://app.example/users", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.1" },
    body: JSON.stringify({ name, email }),
  });
}

function quietConsole<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  return fn().finally(() => {
    console.log = original;
  });
}

function user(id: number, email: string, createdAt: string): User {
  return { id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, name: `User ${id}`, email, createdAt };
}

// ---------------------------------------------------------------------------
// Through the Worker's fetch handler
// ---------------------------------------------------------------------------

Deno.test("worker creates, reads and lists users through D1", async () => {
  const env = fakeEnv();
  const created = await worker.fetch(createRequest("Ada", "ada@example.com"), env);
  assertEquals(created.status, 201);
  const ada = await created.json();

  const fetched = await worker.fetch(new Request(`https://app.example/users/${ada.id}`), env);
  assertEquals(await fetched.json(), ada);

  const listed = await worker.fetch(new Request("https://app.example/users"), env);
  assertEquals((await listed.json()).users, [ada]);
  assertEquals(listed.headers.has("strict-transport-security"), true);
});

Deno.test("worker answers 409 for an email that is already taken, ignoring case", async () => {
  const env = fakeEnv();
  await (await worker.fetch(createRequest("Ada", "ada@example.com"), env)).body?.cancel();
  const duplicate = await worker.fetch(createRequest("Ada Again", "ADA@Example.com"), env);
  assertEquals(duplicate.status, 409);
  assertEquals((await duplicate.json()).error, "email_taken");
});

Deno.test("worker serves static files through the ASSETS binding", async () => {
  const env = fakeEnv();
  const index = await worker.fetch(new Request("https://app.example/"), env);
  assertEquals([index.status, index.headers.get("content-type")], [200, "text/html; charset=utf-8"]);
  await index.body?.cancel();
  const missing = await worker.fetch(new Request("https://app.example/missing.js"), env);
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
});

Deno.test("worker answers a generic 500 when its config is invalid", async () => {
  const response = await quietConsole(() =>
    worker.fetch(new Request("https://app.example/health"), fakeEnv({ CORS_ORIGINS: "*" }))
  );
  assertEquals(response.status, 500);
  assertEquals((await response.json()).error, "internal_error");
});

// ---------------------------------------------------------------------------
// The D1 user store on its own
// ---------------------------------------------------------------------------

Deno.test("D1 store lists the newest users first and honors the limit", async () => {
  const store = createD1UserStore(createSqliteD1());
  await store.create(user(1, "a@example.com", "2026-01-01T00:00:00.000Z"));
  await store.create(user(2, "b@example.com", "2026-01-03T00:00:00.000Z"));
  await store.create(user(3, "c@example.com", "2026-01-02T00:00:00.000Z"));
  assertEquals((await store.listNewest(2)).map((each) => each.email), ["b@example.com", "c@example.com"]);
});

Deno.test("D1 store keeps emails unique and frees them on delete", async () => {
  const store = createD1UserStore(createSqliteD1());
  const first = user(1, "ada@example.com", "2026-01-01T00:00:00.000Z");
  assertEquals(await store.create(first), "created");
  assertEquals(await store.create(user(2, "Ada@Example.COM", "2026-01-02T00:00:00.000Z")), "email_taken");
  assertEquals(await store.find(first.id), first);

  assertEquals(await store.delete(first.id), true);
  assertEquals([await store.find(first.id), await store.delete(first.id)], [null, false]);
  assertEquals(await store.create(user(3, "ada@example.com", "2026-01-03T00:00:00.000Z")), "created");
});
