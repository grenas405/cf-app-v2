/**
 * Serves files from the static root through the injected `readStatic`.
 */
import { badRequest, notFound } from "../core/http.ts";
import { pathOf } from "../core/request.ts";
import { etagFor, sanitizeStaticPath, staticResponse } from "../core/static.ts";
import type { Deps, RouteHandler } from "../core/types.ts";

export function staticRoute(deps: Pick<Deps, "readStatic" | "logger">): RouteHandler {
  return async (req) => {
    const pathname = pathOf(req);
    const path = sanitizeStaticPath(pathname);
    if (!path.ok) {
      deps.logger.warn("static_path_rejected", { path: pathname.slice(0, 200), reason: path.error });
      return badRequest("Invalid path");
    }
    const bytes = await deps.readStatic(path.data);
    if (bytes === null) return notFound();
    return staticResponse(path.data, bytes, await etagFor(bytes), req.headers.get("if-none-match"));
  };
}
