import { assert, assertEquals } from "@std/assert";
import { isOrigin, parseConfig, pickEnv } from "../src/core/config.ts";

Deno.test("parseConfig applies safe defaults", () => {
  const result = parseConfig({});
  assert(result.ok);
  assertEquals(result.data.PORT, 8000);
  assertEquals(result.data.HOST, "127.0.0.1");
  assertEquals(result.data.LOG_LEVEL, "info");
  assertEquals(result.data.CORS_ORIGINS, []);
  assertEquals(result.data.CORS_ALLOW_CREDENTIALS, false);
  assertEquals(result.data.TRUST_PROXY, false);
  assertEquals(result.data.MAX_BODY_BYTES, 16 * 1024);
  assertEquals(result.data.ADMIN_TOKEN, undefined);
});

Deno.test("parseConfig coerces numbers, booleans and origin lists", () => {
  const result = parseConfig({
    PORT: "3000",
    TRUST_PROXY: "true",
    CORS_ORIGINS: " https://a.example , http://localhost:5173 ",
  });
  assert(result.ok);
  assertEquals(result.data.PORT, 3000);
  assertEquals(result.data.TRUST_PROXY, true);
  assertEquals(result.data.CORS_ORIGINS, ["https://a.example", "http://localhost:5173"]);
});

Deno.test("parseConfig accepts primitive Workers vars", () => {
  const result = parseConfig({ PORT: 9000, TRUST_PROXY: true });
  assert(result.ok);
  assertEquals([result.data.PORT, result.data.TRUST_PROXY], [9000, true]);
});

Deno.test("parseConfig treats blank values as unset", () => {
  const result = parseConfig({ ADMIN_TOKEN: "", PORT: "  " });
  assert(result.ok);
  assertEquals([result.data.ADMIN_TOKEN, result.data.PORT], [undefined, 8000]);
});

Deno.test("parseConfig rejects a wildcard CORS origin", () => {
  const result = parseConfig({ CORS_ORIGINS: "*" });
  assert(!result.ok);
  assert(result.error.some((line) => line.includes("Wildcard")), result.error.join("\n"));
});

Deno.test("parseConfig rejects origins with paths, other schemes or garbage", () => {
  for (const origin of ["https://a.example/", "https://a.example/app", "ftp://a.example", "not a url"]) {
    assertEquals(parseConfig({ CORS_ORIGINS: origin }).ok, false, origin);
  }
});

Deno.test("parseConfig rejects out-of-range and malformed values", () => {
  const invalid = [{ PORT: "0" }, { PORT: "70000" }, { PORT: "http" }, { LOG_LEVEL: "verbose" }, {
    TRUST_PROXY: "maybe",
  }];
  for (const env of invalid) {
    assertEquals(parseConfig(env).ok, false, JSON.stringify(env));
  }
});

Deno.test("parseConfig errors name the key but never echo a secret", () => {
  const result = parseConfig({ ADMIN_TOKEN: "too-short-secret" });
  assert(!result.ok);
  assert(result.error[0]?.startsWith("ADMIN_TOKEN:"));
  assertEquals(result.error.join("\n").includes("too-short-secret"), false);
});

Deno.test("pickEnv keeps only known keys", () => {
  const picked = pickEnv({ PORT: "1", PATH: "/usr/bin", AWS_SECRET_ACCESS_KEY: "x" });
  assertEquals(picked.PORT, "1");
  assertEquals("PATH" in picked || "AWS_SECRET_ACCESS_KEY" in picked, false);
});

Deno.test("isOrigin accepts bare http(s) origins only", () => {
  assertEquals(isOrigin("https://example.com"), true);
  assertEquals(isOrigin("http://localhost:8000"), true);
  assertEquals(isOrigin("https://example.com/"), false);
  assertEquals(isOrigin("https://user@example.com"), false);
});
