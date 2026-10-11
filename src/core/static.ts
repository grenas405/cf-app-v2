/**
 * Static files: pure path sanitizing, Content-Type and caching rules.
 * Reading the bytes is a side effect and goes through `deps.readStatic`.
 */
import { sha256, toHex } from "./crypto.ts";
import type { Result } from "./types.ts";

export type PathRejection = "malformed" | "traversal" | "hidden" | "invalid_character";

const MAX_PATH_LENGTH = 1024;

/** Allowlist for one path segment: starts alphanumeric, then [A-Za-z0-9._-]. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Matching control characters (NUL, CR, LF, …) is the point of this pattern.
// deno-lint-ignore no-control-regex
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function checkSegment(segment: string): PathRejection | null {
  if (segment === "" || segment === "." || segment === "..") return "traversal";
  if (segment.startsWith(".")) return "hidden";
  return SEGMENT.test(segment) ? null : "invalid_character";
}

/**
 * Turns a URL pathname into a safe path relative to the static root, e.g.
 * `/` → `index.html`, `/app.js` → `app.js`. Rejects encoded traversal
 * (`..%2f`), absolute paths (`//etc`), backslashes, NUL and other control
 * characters, dotfiles, and anything outside a conservative character set.
 */
export function sanitizeStaticPath(pathname: string): Result<string, PathRejection> {
  const decoded = safeDecode(pathname);
  if (decoded === null || !decoded.startsWith("/") || decoded.length > MAX_PATH_LENGTH) {
    return { ok: false, error: "malformed" };
  }
  if (CONTROL_OR_BACKSLASH.test(decoded)) return { ok: false, error: "invalid_character" };
  const relative = decoded.slice(1);
  const withIndex = relative === "" || relative.endsWith("/") ? `${relative}index.html` : relative;
  const segments = withIndex.split("/");
  for (const segment of segments) {
    const rejection = checkSegment(segment);
    if (rejection !== null) return { ok: false, error: rejection };
  }
  return { ok: true, data: segments.join("/") };
}

/**
 * Defense in depth for adapters: resolves `relativePath` under `root` and
 * returns `null` if the result would escape it.
 */
export function resolveInside(root: URL, relativePath: string): URL | null {
  const base = root.href.endsWith("/") ? root : new URL(`${root.href}/`);
  const target = new URL(relativePath, base);
  return target.href.startsWith(base.href) && target.href !== base.href ? target : null;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
};

/** Long-lived, rarely edited file types. Everything else revalidates via ETag. */
const LONG_CACHE_EXTENSIONS = new Set(["svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "woff", "woff2"]);

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extensionOf(path)] ?? "application/octet-stream";
}

/**
 * HTML, CSS and JS change with every build and have no content hash in their
 * names, so browsers must revalidate them (cheap, thanks to ETags).
 */
export function cacheControlFor(path: string): string {
  return LONG_CACHE_EXTENSIONS.has(extensionOf(path)) ? "public, max-age=86400" : "no-cache";
}

export async function etagFor(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return `"${toHex(await sha256(bytes)).slice(0, 32)}"`;
}

/** True when an If-None-Match header matches `etag` (weak comparison). */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((tag) => opaque(tag) === opaque(etag));
}

export function staticResponse(
  path: string,
  bytes: Uint8Array<ArrayBuffer>,
  etag: string,
  ifNoneMatch: string | null,
): Response {
  const headers = {
    "content-type": contentTypeFor(path),
    "cache-control": cacheControlFor(path),
    etag,
  };
  if (etagMatches(ifNoneMatch, etag)) return new Response(null, { status: 304, headers });
  return new Response(bytes, { headers });
}
