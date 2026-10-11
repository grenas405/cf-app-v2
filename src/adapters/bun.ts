/**
 * Bun adapter. The only file allowed to use `Bun.*`.
 *
 *   bun run start:bun      (or: bun run dev:bun)
 *
 * Storage: in memory (swap in `bun:sqlite` or Redis behind the KvStore interface).
 */
import { createApp } from "../app.ts";
import { type AppConfig, parseConfig } from "../core/config.ts";
import { withClientIp } from "../core/request.ts";
import { resolveInside } from "../core/static.ts";
import { createMemoryKv } from "../stores/memory.ts";
import { createKvUserStore } from "../users.ts";
import { createDeps, fallbackErrorResponse, listenUrl, startupErrorLine } from "./common.ts";

/**
 * The few Bun APIs used here, typed locally so `deno check` can verify this
 * file without pulling @types/bun into the project. See https://bun.sh/docs/api/http.
 */
interface BunServer {
  readonly hostname: string;
  readonly port: number;
  requestIP(req: Request): { readonly address: string } | null;
}
interface BunServeOptions {
  readonly hostname: string;
  readonly port: number;
  /** Seconds; must exceed the SSE heartbeat interval. */
  readonly idleTimeout: number;
  fetch(req: Request, server: BunServer): Promise<Response>;
  error(error: Error): Response;
}
interface BunFile {
  exists(): Promise<boolean>;
  bytes(): Promise<Uint8Array<ArrayBuffer>>;
}
declare const Bun: {
  readonly env: Readonly<Record<string, string | undefined>>;
  serve(options: BunServeOptions): BunServer;
  file(path: URL): BunFile;
};
declare const process: { exit(code: number): never };

const PUBLIC_DIR = new URL("../../public/", import.meta.url);

/** Comfortably above the 60 s maximum SSE heartbeat. */
const IDLE_TIMEOUT_SECONDS = 120;

function writeLine(line: string): void {
  console.error(line);
}

function loadConfig(): AppConfig {
  const result = parseConfig(Bun.env);
  if (result.ok) return result.data;
  writeLine(startupErrorLine("invalid_config", { errors: result.error }));
  process.exit(1);
}

function isMissingFileError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "EISDIR";
}

async function readStatic(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const url = resolveInside(PUBLIC_DIR, path);
  if (url === null) return null;
  const file = Bun.file(url);
  if (!(await file.exists())) return null;
  try {
    return await file.bytes();
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

const config = loadConfig();
const deps = createDeps({ config, users: createKvUserStore(createMemoryKv()), readStatic, write: writeLine });
const app = createApp(deps);

const server = Bun.serve({
  hostname: config.HOST,
  port: config.PORT,
  idleTimeout: IDLE_TIMEOUT_SECONDS,
  fetch: (req, srv) => app(withClientIp(req, srv.requestIP(req)?.address)),
  error: (error) => {
    deps.logger.error("adapter_error", { error });
    return fallbackErrorResponse();
  },
});

deps.logger.info("server_started", { runtime: "bun", url: listenUrl(server.hostname, server.port) });
