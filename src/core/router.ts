/**
 * A tiny URLPattern router. Routes are plain data; matching is a pure
 * function; `createRouter` turns the two into a `Handler`.
 */
import { methodNotAllowed, noContent, notFound } from "./http.ts";
import { compose } from "./middleware.ts";
import type { Handler, Middleware, Params, RouteHandler } from "./types.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Route {
  readonly method: Method;
  /** URLPattern pathname syntax, e.g. `/users/:id` or `/*`. */
  readonly path: string;
  readonly handler: RouteHandler;
  /** Route-specific middleware, outermost first (e.g. an auth check). */
  readonly middleware?: readonly Middleware[];
}

export interface CompiledRoute extends Route {
  readonly pattern: URLPattern;
}

export type RouteMatch =
  | { readonly kind: "found"; readonly route: CompiledRoute; readonly params: Params }
  | { readonly kind: "method_not_allowed"; readonly allow: readonly string[] }
  | { readonly kind: "not_found" };

export function compileRoutes(routes: readonly Route[]): readonly CompiledRoute[] {
  return routes.map((route) => ({ ...route, pattern: new URLPattern({ pathname: route.path }) }));
}

/**
 * Finds the first route whose path and method match. If only the path
 * matches, reports which methods would have. HEAD is served by GET routes.
 */
export function matchRoute(routes: readonly CompiledRoute[], method: string, pathname: string): RouteMatch {
  const wanted = method === "HEAD" ? "GET" : method;
  const pathMatches: Method[] = [];
  for (const route of routes) {
    const result = route.pattern.exec({ pathname });
    if (result === null) continue;
    if (route.method === wanted) {
      return { kind: "found", route, params: toParams(result.pathname.groups) };
    }
    pathMatches.push(route.method);
  }
  if (pathMatches.length === 0) return { kind: "not_found" };
  return { kind: "method_not_allowed", allow: allowedMethods(pathMatches) };
}

function toParams(groups: Record<string, string | undefined>): Params {
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(groups)) {
    if (value !== undefined) params[name] = value;
  }
  return params;
}

export function allowedMethods(methods: readonly Method[]): readonly string[] {
  const unique = new Set<string>(methods);
  if (unique.has("GET")) unique.add("HEAD");
  unique.add("OPTIONS");
  return [...unique].sort();
}

export function createRouter(routes: readonly Route[]): Handler {
  const compiled = compileRoutes(routes);
  return (req) => respond(matchRoute(compiled, req.method, new URL(req.url).pathname), req);
}

function respond(match: RouteMatch, req: Request): Promise<Response> {
  switch (match.kind) {
    case "found":
      return runRoute(match.route, match.params, req);
    case "method_not_allowed":
      return Promise.resolve(
        req.method === "OPTIONS" ? noContent({ allow: match.allow.join(", ") }) : methodNotAllowed(match.allow),
      );
    case "not_found":
      return Promise.resolve(notFound());
  }
}

function runRoute(route: CompiledRoute, params: Params, req: Request): Promise<Response> {
  const handler: Handler = (request) => route.handler(request, params);
  return compose(...(route.middleware ?? []))(handler)(req);
}
