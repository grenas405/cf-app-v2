/**
 * Cloudflare Workers adapter.
 *
 *   npm run dev:worker      (wrangler dev; bindings in wrangler.jsonc)
 *
 * Bindings:
 *   USERS_KV  KV namespace for user records
 *   ASSETS    static assets from ./public, with run_worker_first so every
 *             request goes through the app (and its security headers)
 * Config comes from `vars` and secrets (`wrangler secret put ADMIN_TOKEN`).
 *
 * Rate-limit counters and SSE subscribers live in the isolate's memory, so
 * they are per-isolate (best effort). Use a Durable Object or the Workers
 * Rate Limiting binding behind the same interfaces for global guarantees.
 */
import { createApp } from "../app.ts";
import { parseConfig } from "../core/config.ts";
import { withClientIp } from "../core/request.ts";
import type { Handler, KvKey, KvStore, ReadStatic } from "../core/types.ts";
import { adapterErrorResponse, createDeps, startupErrorLine } from "./common.ts";

/**
 * Structural subsets of the Workers runtime types used here, so the project
 * needs no @cloudflare/workers-types. Real bindings satisfy these shapes.
 */
export interface KvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit: number }): Promise<{ keys: readonly { name: string }[] }>;
}

export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  readonly USERS_KV: KvNamespace;
  readonly ASSETS: AssetsBinding;
  readonly [variable: string]: unknown;
}

/** Key parts are URI-encoded, so `/` can separate them unambiguously. */
export function encodeKvKey(key: KvKey): string {
  return key.map(encodeURIComponent).join("/");
}

export function decodeKvKey(name: string): KvKey {
  return name.split("/").map(decodeURIComponent);
}

function cloudflareKvStore(namespace: KvNamespace): KvStore {
  return {
    get: (key) => namespace.get(encodeKvKey(key)),
    set: (key, value) => namespace.put(encodeKvKey(key), value),
    delete: (key) => namespace.delete(encodeKvKey(key)),
    list: async (prefix, limit) => {
      const { keys } = await namespace.list({ prefix: `${encodeKvKey(prefix)}/`, limit });
      const values = await Promise.all(keys.map((key) => namespace.get(key.name)));
      return keys.flatMap((key, index) => {
        const value = values[index];
        return typeof value === "string" ? [{ key: decodeKvKey(key.name), value }] : [];
      });
    },
  };
}

/** Reads through the ASSETS binding; `html_handling: "none"` keeps paths literal. */
function assetReader(assets: AssetsBinding): ReadStatic {
  return async (path) => {
    const response = await assets.fetch(new Request(`https://assets.invalid/${path}`));
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) throw new Error(`ASSETS returned status ${response.status} for ${path}`);
    return new Uint8Array(await response.arrayBuffer());
  };
}

function writeLine(line: string): void {
  console.log(line);
}

/** With invalid config every request fails loudly (logged) but generically (to clients). */
function misconfiguredApp(errors: readonly string[]): Handler {
  writeLine(startupErrorLine("invalid_config", { errors }));
  return () => Promise.resolve(adapterErrorResponse(500, "internal_error", "Internal Server Error"));
}

function buildApp(env: Env): Handler {
  const config = parseConfig(env);
  if (!config.ok) return misconfiguredApp(config.error);
  return createApp(createDeps({
    config: config.data,
    kv: cloudflareKvStore(env.USERS_KV),
    readStatic: assetReader(env.ASSETS),
    write: writeLine,
  }));
}

/** One app per isolate (per `env`), so in-memory state survives across requests. */
const apps = new WeakMap<Env, Handler>();

function appFor(env: Env): Handler {
  const existing = apps.get(env);
  if (existing !== undefined) return existing;
  const app = buildApp(env);
  apps.set(env, app);
  return app;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const ip = request.headers.get("cf-connecting-ip") ?? undefined;
    return appFor(env)(withClientIp(request, ip));
  },
};
