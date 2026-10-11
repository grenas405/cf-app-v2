/**
 * The Workers adapter has no import-time side effects, so it can be exercised
 * here with fake bindings (no wrangler, no network).
 */
import { assertEquals } from "@std/assert";
import worker, { decodeKvKey, encodeKvKey, type Env, type KvNamespace } from "../src/adapters/worker.ts";
import { ADMIN_TOKEN } from "./helpers.ts";

function fakeKvNamespace(): KvNamespace {
  const store = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(store.get(key) ?? null),
    put: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
    list: ({ prefix, limit }) => {
      const names = [...store.keys()].filter((name) => name.startsWith(prefix)).sort().slice(0, limit);
      return Promise.resolve({ keys: names.map((name) => ({ name })) });
    },
  };
}

function fakeEnv(vars: Readonly<Record<string, unknown>> = {}): Env {
  return {
    USERS_KV: fakeKvNamespace(),
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

function quietConsole<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  return fn().finally(() => {
    console.log = original;
  });
}

Deno.test("worker KV keys round-trip, even with separators inside parts", () => {
  const key = ["users", "a/b", "c d"];
  assertEquals(encodeKvKey(key), "users/a%2Fb/c%20d");
  assertEquals(decodeKvKey(encodeKvKey(key)), key);
});

Deno.test("worker creates and lists users through the KV binding", async () => {
  const env = fakeEnv();
  const created = await worker.fetch(
    new Request("https://app.example/users", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.1" },
      body: JSON.stringify({ name: "Ada", email: "ada@example.com" }),
    }),
    env,
  );
  assertEquals(created.status, 201);
  const user = await created.json();

  const listed = await worker.fetch(new Request("https://app.example/users"), env);
  assertEquals((await listed.json()).users, [user]);
  assertEquals(listed.headers.has("strict-transport-security"), true);
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
