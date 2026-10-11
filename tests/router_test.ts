import { assertEquals } from "@std/assert";
import { json } from "../src/core/http.ts";
import { compileRoutes, createRouter, matchRoute, type Route } from "../src/core/router.ts";
import type { Middleware, RouteHandler } from "../src/core/types.ts";
import { BASE_URL } from "./helpers.ts";

const named = (name: string): RouteHandler => (_req, params) => Promise.resolve(json({ name, params }));

const ROUTES: readonly Route[] = [
  { method: "GET", path: "/users", handler: named("list") },
  { method: "POST", path: "/users", handler: named("create") },
  { method: "GET", path: "/users/:id", handler: named("show") },
  { method: "GET", path: "/files/*", handler: named("files") },
];

const compiled = compileRoutes(ROUTES);

Deno.test("matchRoute finds a route and captures named params", () => {
  const match = matchRoute(compiled, "GET", "/users/42");
  assertEquals(match.kind, "found");
  if (match.kind === "found") {
    assertEquals(match.route.path, "/users/:id");
    assertEquals(match.params, { id: "42" });
  }
});

Deno.test("matchRoute picks the route whose method matches", () => {
  const match = matchRoute(compiled, "POST", "/users");
  assertEquals(match.kind === "found" && match.route.method, "POST");
});

Deno.test("matchRoute serves HEAD with GET routes", () => {
  const match = matchRoute(compiled, "HEAD", "/users");
  assertEquals(match.kind === "found" && match.route.method, "GET");
});

Deno.test("matchRoute reports allowed methods when only the path matches", () => {
  assertEquals(matchRoute(compiled, "DELETE", "/users"), {
    kind: "method_not_allowed",
    allow: ["GET", "HEAD", "OPTIONS", "POST"],
  });
});

Deno.test("matchRoute reports not_found for unknown paths", () => {
  assertEquals(matchRoute(compiled, "GET", "/nope"), { kind: "not_found" });
  assertEquals(matchRoute(compiled, "GET", "/users/1/extra"), { kind: "not_found" });
});

Deno.test("matchRoute captures wildcards", () => {
  const match = matchRoute(compiled, "GET", "/files/a/b.txt");
  assertEquals(match.kind === "found" && match.params, { "0": "a/b.txt" });
});

Deno.test("router answers unknown paths with a JSON 404", async () => {
  const response = await createRouter(ROUTES)(new Request(`${BASE_URL}/missing`));
  assertEquals(response.status, 404);
  assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8");
  assertEquals(await response.json(), { error: "not_found", message: "Not Found" });
});

Deno.test("router answers wrong methods with 405 and an Allow header", async () => {
  const response = await createRouter(ROUTES)(new Request(`${BASE_URL}/users`, { method: "PUT" }));
  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "GET, HEAD, OPTIONS, POST");
  await response.body?.cancel();
});

Deno.test("router answers OPTIONS with 204 and an Allow header", async () => {
  const response = await createRouter(ROUTES)(new Request(`${BASE_URL}/users/1`, { method: "OPTIONS" }));
  assertEquals(response.status, 204);
  assertEquals(response.headers.get("allow"), "GET, HEAD, OPTIONS");
});

Deno.test("router passes params to the handler", async () => {
  const response = await createRouter(ROUTES)(new Request(`${BASE_URL}/users/abc`));
  assertEquals(await response.json(), { name: "show", params: { id: "abc" } });
});

Deno.test("router runs route-level middleware around only that route", async () => {
  const seen: string[] = [];
  const tag: Middleware = (next) => (req) => {
    seen.push(new URL(req.url).pathname);
    return next(req);
  };
  const router = createRouter([
    { method: "GET", path: "/open", handler: named("open") },
    { method: "GET", path: "/guarded", handler: named("guarded"), middleware: [tag] },
  ]);
  await (await router(new Request(`${BASE_URL}/open`))).body?.cancel();
  await (await router(new Request(`${BASE_URL}/guarded`))).body?.cancel();
  assertEquals(seen, ["/guarded"]);
});
