/**
 * zod helpers for untrusted input. They return results instead of throwing,
 * so handlers stay linear: parse, check `ok`, continue or respond.
 */
import type { z } from "zod";
import { errorResponse, unsupportedMediaType } from "./http.ts";
import type { Params, Result } from "./types.ts";

export type InputSource = "body" | "params" | "query" | "headers";

/** A readable, client-safe description of one validation problem. */
export interface Issue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type ValidationError =
  | { readonly kind: "unsupported_media_type" }
  | { readonly kind: "invalid_json" }
  | { readonly kind: "invalid_input"; readonly source: InputSource; readonly issues: readonly Issue[] };

export type Validated<T> = Result<T, ValidationError>;

/** Caps the size of error responses no matter how broken the input is. */
const MAX_ISSUES = 20;

export function toIssues(error: z.ZodError): Issue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  }));
}

export function parseInput<S extends z.ZodType>(
  schema: S,
  input: unknown,
  source: InputSource,
): Validated<z.output<S>> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, error: { kind: "invalid_input", source, issues: toIssues(result.error) } };
}

export function parseParams<S extends z.ZodType>(params: Params, schema: S): Validated<z.output<S>> {
  return parseInput(schema, params, "params");
}

/** Repeated keys become arrays, so a schema expecting one string rejects them. */
export function queryToObject(searchParams: URLSearchParams): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    result[key] = values.length === 1 ? values[0] ?? "" : values;
  }
  return result;
}

export function parseQuery<S extends z.ZodType>(url: URL, schema: S): Validated<z.output<S>> {
  return parseInput(schema, queryToObject(url.searchParams), "query");
}

/** Header names arrive lowercased. Use a non-strict object schema: requests carry many headers. */
export function parseHeaders<S extends z.ZodType>(headers: Headers, schema: S): Validated<z.output<S>> {
  return parseInput(schema, Object.fromEntries(headers), "headers");
}

export function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Reads and validates a JSON body. The body size is limited earlier by the
 * `bodyLimit` middleware, so this only deals with format and shape.
 */
export async function parseJson<S extends z.ZodType>(req: Request, schema: S): Promise<Validated<z.output<S>>> {
  if (mediaType(req.headers.get("content-type")) !== "application/json") {
    return { ok: false, error: { kind: "unsupported_media_type" } };
  }
  const parsed = parseJsonText(await req.text());
  if (!parsed.ok) return parsed;
  return parseInput(schema, parsed.data, "body");
}

export function parseJsonText(body: string): Validated<unknown> {
  try {
    return { ok: true, data: JSON.parse(body) as unknown };
  } catch {
    return { ok: false, error: { kind: "invalid_json" } };
  }
}

/** Maps a validation error to a 400 (or 415) JSON response with issue details. */
export function validationErrorResponse(error: ValidationError): Response {
  switch (error.kind) {
    case "unsupported_media_type":
      return unsupportedMediaType("application/json");
    case "invalid_json":
      return errorResponse(400, "invalid_json", "Request body is not valid JSON");
    case "invalid_input":
      return errorResponse(400, "validation_failed", `Invalid request ${error.source}`, {
        issues: error.issues,
      });
  }
}

/** Log fields for a validation failure: shape of the problem, never the input values. */
export function describeValidationError(error: ValidationError): Readonly<Record<string, unknown>> {
  if (error.kind !== "invalid_input") return { kind: error.kind };
  return {
    kind: error.kind,
    source: error.source,
    issues: error.issues.map((issue) => `${issue.path || "(root)"}:${issue.code}`),
  };
}
