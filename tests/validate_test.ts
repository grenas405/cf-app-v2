import { assertEquals } from "@std/assert";
import { z } from "zod";
import {
  describeValidationError,
  parseJson,
  parseQuery,
  queryToObject,
  validationErrorResponse,
} from "../src/core/validate.ts";
import { BASE_URL } from "./helpers.ts";

const Schema = z.object({ name: z.string().min(1).max(5) }).strict();

function jsonRequest(body: string, contentType = "application/json"): Request {
  return new Request(`${BASE_URL}/x`, { method: "POST", headers: { "content-type": contentType }, body });
}

Deno.test("parseJson returns typed data for valid input", async () => {
  assertEquals(await parseJson(jsonRequest('{"name":"Ada"}'), Schema), { ok: true, data: { name: "Ada" } });
});

Deno.test("parseJson accepts a charset parameter on the media type", async () => {
  const result = await parseJson(jsonRequest('{"name":"Ada"}', "Application/JSON; charset=utf-8"), Schema);
  assertEquals(result.ok, true);
});

Deno.test("parseJson rejects other content types without reading the body", async () => {
  const result = await parseJson(jsonRequest('{"name":"Ada"}', "text/plain"), Schema);
  assertEquals(result, { ok: false, error: { kind: "unsupported_media_type" } });
});

Deno.test("parseJson reports malformed JSON", async () => {
  assertEquals(await parseJson(jsonRequest("{nope"), Schema), { ok: false, error: { kind: "invalid_json" } });
});

Deno.test("parseJson reports schema issues with paths and codes", async () => {
  const result = await parseJson(jsonRequest('{"name":"far too long"}'), Schema);
  assertEquals(result.ok, false);
  if (!result.ok && result.error.kind === "invalid_input") {
    assertEquals(result.error.source, "body");
    assertEquals(result.error.issues.map((issue) => [issue.path, issue.code]), [["name", "too_big"]]);
  }
});

Deno.test("parseJson rejects unknown fields on strict schemas", async () => {
  const result = await parseJson(jsonRequest('{"name":"Ada","admin":true}'), Schema);
  assertEquals(result.ok, false);
  if (!result.ok && result.error.kind === "invalid_input") {
    assertEquals(result.error.issues[0]?.code, "unrecognized_keys");
  }
});

Deno.test("parseJson rejects a __proto__ key instead of merging it", async () => {
  const result = await parseJson(jsonRequest('{"name":"Ada","__proto__":{"admin":true}}'), Schema);
  assertEquals(result.ok, false);
});

Deno.test("queryToObject turns repeated keys into arrays", () => {
  assertEquals(queryToObject(new URLSearchParams("a=1&b=2&a=3")), { a: ["1", "3"], b: "2" });
});

Deno.test("parseQuery rejects a repeated key where one value is expected", () => {
  const result = parseQuery(new URL(`${BASE_URL}/?name=a&name=b`), Schema);
  assertEquals(result.ok, false);
});

Deno.test("validationErrorResponse maps invalid input to a 400 with issue details", async () => {
  const response = validationErrorResponse({
    kind: "invalid_input",
    source: "body",
    issues: [{ path: "name", code: "too_big", message: "Too big" }],
  });
  assertEquals(response.status, 400);
  assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8");
  assertEquals(await response.json(), {
    error: "validation_failed",
    message: "Invalid request body",
    issues: [{ path: "name", code: "too_big", message: "Too big" }],
  });
});

Deno.test("validationErrorResponse maps media type and JSON errors", async () => {
  const unsupported = validationErrorResponse({ kind: "unsupported_media_type" });
  const invalid = validationErrorResponse({ kind: "invalid_json" });
  assertEquals([unsupported.status, invalid.status], [415, 400]);
  assertEquals((await invalid.json()).error, "invalid_json");
  await unsupported.body?.cancel();
});

Deno.test("describeValidationError logs the shape of the problem, not the values", async () => {
  const result = await parseJson(jsonRequest('{"name":"secret-value-123"}'), Schema);
  if (result.ok) throw new Error("expected a validation failure");
  const fields = describeValidationError(result.error);
  assertEquals(fields, { kind: "invalid_input", source: "body", issues: ["name:too_big"] });
  assertEquals(JSON.stringify(fields).includes("secret-value-123"), false);
});
