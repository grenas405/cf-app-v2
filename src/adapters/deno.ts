/**
 * Deno adapter. The only file allowed to use `Deno.*`.
 *
 *   deno task start      (or: deno task dev)
 *
 * Storage: Deno KV (needs --unstable-kv), persisted in Deno's cache directory.
 * --unstable-no-legacy-abort: request.signal aborts only when the client disconnects.
 */
import { createApp } from "../app.ts";
import { type AppConfig, CONFIG_KEYS, parseConfig } from "../core/config.ts";
import { withClientIp } from "../core/request.ts";
import { resolveInside } from "../core/static.ts";
import type { KvEntry, KvStore } from "../core/types.ts";
import { createKvUserStore } from "../users.ts";
import { createDeps, fallbackErrorResponse, listenUrl, startupErrorLine } from "./common.ts";

const PUBLIC_DIR = new URL("../../public/", import.meta.url);

function writeLine(line: string): void {
  console.error(line);
}

function loadConfig(): AppConfig {
  const env = Object.fromEntries(CONFIG_KEYS.map((key) => [key, Deno.env.get(key)]));
  const result = parseConfig(env);
  if (result.ok) return result.data;
  writeLine(startupErrorLine("invalid_config", { errors: result.error }));
  Deno.exit(1);
}

function denoKvStore(kv: Deno.Kv): KvStore {
  return {
    get: async (key) => {
      const entry = await kv.get(key);
      return typeof entry.value === "string" ? entry.value : null;
    },
    set: async (key, value) => {
      await kv.set(key, value);
    },
    setIfAbsent: async (key, value) => {
      const result = await kv.atomic().check({ key, versionstamp: null }).set(key, value).commit();
      return result.ok;
    },
    delete: async (key) => {
      await kv.delete(key);
    },
    list: async (prefix, limit) => {
      const entries: KvEntry[] = [];
      for await (const entry of kv.list({ prefix }, { limit })) {
        if (typeof entry.value === "string") entries.push({ key: entry.key.map(String), value: entry.value });
      }
      return entries;
    },
  };
}

async function readStatic(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const file = resolveInside(PUBLIC_DIR, path);
  if (file === null) return null;
  try {
    return await Deno.readFile(file);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound || error instanceof Deno.errors.IsADirectory) return null;
    throw error;
  }
}

const config = loadConfig();
const users = createKvUserStore(denoKvStore(await Deno.openKv()));
const deps = createDeps({ config, users, readStatic, write: writeLine });
const app = createApp(deps);

Deno.serve({
  hostname: config.HOST,
  port: config.PORT,
  onListen: ({ hostname, port }) => {
    deps.logger.info("server_started", { runtime: "deno", url: listenUrl(hostname, port) });
  },
  onError: (error) => {
    deps.logger.error("adapter_error", { error });
    return fallbackErrorResponse();
  },
}, (req, info) => app(withClientIp(req, info.remoteAddr.hostname)));
