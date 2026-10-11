/**
 * Cloudflare Workers adapter.
 *
 *   npm run dev:worker      (wrangler dev; bindings in wrangler.jsonc)
 *
 * Bindings:
 *   DB      D1 database for user records. `wrangler deploy` creates it if it
 *           does not exist; the table is created on first use.
 *   ASSETS  static assets from ./public, with run_worker_first so every
 *           request goes through the app (and its security headers)
 * Config comes from `vars` and secrets (`wrangler secret put ADMIN_TOKEN`).
 *
 * Rate-limit counters and SSE subscribers live in the isolate's memory, so
 * they are per-isolate (best effort). Use a Durable Object or the Workers
 * Rate Limiting binding behind the same interfaces for global guarantees.
 */
import { createApp } from "../app.ts";
import { parseConfig } from "../core/config.ts";
import { withClientIp } from "../core/request.ts";
import type { Handler, ReadStatic } from "../core/types.ts";
import { toUser, type User, type UserStore } from "../users.ts";
import { adapterErrorResponse, createDeps, startupErrorLine } from "./common.ts";

/**
 * Structural subsets of the Workers runtime types used here, so the project
 * needs no @cloudflare/workers-types. Real bindings satisfy these shapes.
 */
export interface D1Result<T = unknown> {
  readonly results: T[];
  readonly meta: { readonly changes: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first(): Promise<unknown>;
  all(): Promise<D1Result>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  readonly DB: D1Database;
  readonly ASSETS: AssetsBinding;
  readonly [variable: string]: unknown;
}

// ---------------------------------------------------------------------------
// D1 user store
// ---------------------------------------------------------------------------

/**
 * Idempotent, so it is simply run once per isolate before the first query.
 * When the schema needs to change, move to `wrangler d1 migrations`.
 */
const USERS_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS users_newest_first ON users (created_at DESC, id)",
];

const SELECT_USERS = "SELECT id, name, email, created_at AS createdAt FROM users";

export function createD1UserStore(db: D1Database): UserStore {
  let schema: Promise<unknown> | undefined;
  const ready = (): Promise<unknown> => {
    schema ??= db.batch(USERS_SCHEMA.map((sql) => db.prepare(sql))).catch((error: unknown) => {
      schema = undefined; // try again on the next request
      throw error;
    });
    return schema;
  };
  return {
    // The UNIQUE constraint decides atomically whether the email is taken.
    create: async (user) => {
      await ready();
      const result = await db
        .prepare("INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING")
        .bind(user.id, user.name, user.email, user.createdAt)
        .run();
      return result.meta.changes === 1 ? "created" : "email_taken";
    },
    find: async (id) => {
      await ready();
      return toUser(await db.prepare(`${SELECT_USERS} WHERE id = ?`).bind(id).first());
    },
    listNewest: async (limit) => {
      await ready();
      const { results } = await db.prepare(`${SELECT_USERS} ORDER BY created_at DESC, id LIMIT ?`).bind(limit).all();
      return results.map((row) => toUser(row)).filter((user): user is User => user !== null);
    },
    delete: async (id) => {
      await ready();
      const result = await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
      return result.meta.changes > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Static assets, logging, app
// ---------------------------------------------------------------------------

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
    users: createD1UserStore(env.DB),
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
