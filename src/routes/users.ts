/**
 * User route handlers. Each factory receives only the dependencies it uses.
 */
import { conflict, json, noContent, notFound } from "../core/http.ts";
import { pathOf } from "../core/request.ts";
import type { Deps, Logger, RouteHandler } from "../core/types.ts";
import {
  describeValidationError,
  parseJson,
  parseParams,
  parseQuery,
  type ValidationError,
  validationErrorResponse,
} from "../core/validate.ts";
import { buildUser, CreateUserSchema, ListUsersQuerySchema, UserParamsSchema } from "../users.ts";

/** Logs a validation failure as a security event, then builds the 400/415 response. */
function rejectInvalid(logger: Logger, req: Request, error: ValidationError): Response {
  logger.warn("validation_failed", { method: req.method, path: pathOf(req), ...describeValidationError(error) });
  return validationErrorResponse(error);
}

export function listUsersRoute(deps: Pick<Deps, "users" | "logger">): RouteHandler {
  return async (req) => {
    const query = parseQuery(new URL(req.url), ListUsersQuerySchema);
    if (!query.ok) return rejectInvalid(deps.logger, req, query.error);
    return json({ users: await deps.users.listNewest(query.data.limit) });
  };
}

export function getUserRoute(deps: Pick<Deps, "users" | "logger">): RouteHandler {
  return async (req, params) => {
    const parsed = parseParams(params, UserParamsSchema);
    if (!parsed.ok) return rejectInvalid(deps.logger, req, parsed.error);
    const user = await deps.users.find(parsed.data.id);
    return user === null ? notFound("User not found") : json(user);
  };
}

export function createUserRoute(deps: Pick<Deps, "users" | "logger" | "clock" | "newId" | "events">): RouteHandler {
  return async (req) => {
    const body = await parseJson(req, CreateUserSchema);
    if (!body.ok) return rejectInvalid(deps.logger, req, body.error);
    const user = buildUser(body.data, deps.newId(), deps.clock.now());
    if ((await deps.users.create(user)) === "email_taken") {
      return conflict("email_taken", "A user with this email already exists");
    }
    deps.events.publish({ event: "user.created", data: user });
    return json(user, { status: 201, headers: { location: `/users/${user.id}` } });
  };
}

export function deleteUserRoute(deps: Pick<Deps, "users" | "logger" | "events">): RouteHandler {
  return async (req, params) => {
    const parsed = parseParams(params, UserParamsSchema);
    if (!parsed.ok) return rejectInvalid(deps.logger, req, parsed.error);
    const deleted = await deps.users.delete(parsed.data.id);
    if (!deleted) return notFound("User not found");
    deps.events.publish({ event: "user.deleted", data: { id: parsed.data.id } });
    return noContent();
  };
}
