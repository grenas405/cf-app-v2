/**
 * User route handlers. Each factory receives only the dependencies it uses.
 */
import { json, noContent, notFound } from "../core/http.ts";
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
import {
  buildUser,
  CreateUserSchema,
  deleteUser,
  findUser,
  listUsers,
  ListUsersQuerySchema,
  saveUser,
  UserParamsSchema,
} from "../users.ts";

/** Logs a validation failure as a security event, then builds the 400/415 response. */
function rejectInvalid(logger: Logger, req: Request, error: ValidationError): Response {
  logger.warn("validation_failed", { method: req.method, path: pathOf(req), ...describeValidationError(error) });
  return validationErrorResponse(error);
}

export function listUsersRoute(deps: Pick<Deps, "kv" | "logger">): RouteHandler {
  return async (req) => {
    const query = parseQuery(new URL(req.url), ListUsersQuerySchema);
    if (!query.ok) return rejectInvalid(deps.logger, req, query.error);
    return json({ users: await listUsers(deps.kv, query.data.limit) });
  };
}

export function getUserRoute(deps: Pick<Deps, "kv" | "logger">): RouteHandler {
  return async (req, params) => {
    const parsed = parseParams(params, UserParamsSchema);
    if (!parsed.ok) return rejectInvalid(deps.logger, req, parsed.error);
    const user = await findUser(deps.kv, parsed.data.id);
    return user === null ? notFound("User not found") : json(user);
  };
}

export function createUserRoute(deps: Pick<Deps, "kv" | "logger" | "clock" | "newId" | "events">): RouteHandler {
  return async (req) => {
    const body = await parseJson(req, CreateUserSchema);
    if (!body.ok) return rejectInvalid(deps.logger, req, body.error);
    const user = buildUser(body.data, deps.newId(), deps.clock.now());
    await saveUser(deps.kv, user);
    deps.events.publish({ event: "user.created", data: user });
    return json(user, { status: 201, headers: { location: `/users/${user.id}` } });
  };
}

export function deleteUserRoute(deps: Pick<Deps, "kv" | "logger" | "events">): RouteHandler {
  return async (req, params) => {
    const parsed = parseParams(params, UserParamsSchema);
    if (!parsed.ok) return rejectInvalid(deps.logger, req, parsed.error);
    const deleted = await deleteUser(deps.kv, parsed.data.id);
    if (!deleted) return notFound("User not found");
    deps.events.publish({ event: "user.deleted", data: { id: parsed.data.id } });
    return noContent();
  };
}
