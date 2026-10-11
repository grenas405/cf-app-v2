import { assertEquals } from "@std/assert";
import {
  cacheControlFor,
  contentTypeFor,
  etagFor,
  etagMatches,
  extensionOf,
  type PathRejection,
  resolveInside,
  sanitizeStaticPath,
} from "../src/core/static.ts";

Deno.test("sanitizeStaticPath maps URL paths to safe relative paths", () => {
  const cases: [string, string][] = [
    ["/", "index.html"],
    ["/app.js", "app.js"],
    ["/assets/logo.svg", "assets/logo.svg"],
    ["/docs/", "docs/index.html"],
    ["/v1.2/data.json", "v1.2/data.json"],
  ];
  for (const [input, expected] of cases) {
    assertEquals(sanitizeStaticPath(input), { ok: true, data: expected }, input);
  }
});

Deno.test("sanitizeStaticPath rejects traversal, absolute paths and odd characters", () => {
  const cases: [string, PathRejection][] = [
    ["/..%2fsecret", "traversal"],
    ["/a/..%2F..%2Fb", "traversal"],
    ["/%2e%2e%2fetc", "traversal"],
    ["//etc/passwd", "traversal"],
    ["/a//b", "traversal"],
    ["/.env", "hidden"],
    ["/assets/.secret", "hidden"],
    ["/a%5cb", "invalid_character"],
    ["/a%00b", "invalid_character"],
    ["/a%0ab", "invalid_character"],
    ["/my%20file.txt", "invalid_character"],
    ["/C:", "invalid_character"],
    ["/%E0%A4%A", "malformed"],
    [`/${"a".repeat(2000)}`, "malformed"],
  ];
  for (const [input, reason] of cases) {
    assertEquals(sanitizeStaticPath(input), { ok: false, error: reason }, input);
  }
});

Deno.test("resolveInside keeps paths under the root", () => {
  const root = new URL("file:///srv/app/public/");
  assertEquals(resolveInside(root, "app.js")?.href, "file:///srv/app/public/app.js");
  assertEquals(resolveInside(root, "../secret"), null);
  assertEquals(resolveInside(root, "/etc/passwd"), null);
  assertEquals(resolveInside(new URL("file:///srv/app/public"), "app.js")?.href, "file:///srv/app/public/app.js");
});

Deno.test("contentTypeFor knows common types and falls back to octet-stream", () => {
  assertEquals(contentTypeFor("index.html"), "text/html; charset=utf-8");
  assertEquals(contentTypeFor("app.js"), "text/javascript; charset=utf-8");
  assertEquals(contentTypeFor("styles.CSS"), "text/css; charset=utf-8");
  assertEquals(contentTypeFor("logo.svg"), "image/svg+xml");
  assertEquals(contentTypeFor("data.bin"), "application/octet-stream");
  assertEquals(contentTypeFor("Makefile"), "application/octet-stream");
});

Deno.test("extensionOf ignores dots in directory names and dotfiles", () => {
  assertEquals(extensionOf("v1.2/readme"), "");
  assertEquals(extensionOf("archive.tar.gz"), "gz");
});

Deno.test("cacheControlFor revalidates code and caches images", () => {
  assertEquals(cacheControlFor("index.html"), "no-cache");
  assertEquals(cacheControlFor("app.js"), "no-cache");
  assertEquals(cacheControlFor("favicon.svg"), "public, max-age=86400");
});

Deno.test("etagFor is stable and content-dependent", async () => {
  const encoder = new TextEncoder();
  const a = await etagFor(encoder.encode("a"));
  assertEquals(a, await etagFor(encoder.encode("a")));
  assertEquals(a === await etagFor(encoder.encode("b")), false);
});

Deno.test("etagMatches handles lists, weak tags and *", () => {
  assertEquals(etagMatches(null, '"x"'), false);
  assertEquals(etagMatches('"x"', '"x"'), true);
  assertEquals(etagMatches('"a", W/"x"', '"x"'), true);
  assertEquals(etagMatches("*", '"x"'), true);
  assertEquals(etagMatches('"y"', '"x"'), false);
});
