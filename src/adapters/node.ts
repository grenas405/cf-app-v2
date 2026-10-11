/**
 * Node adapter (node:http). The only file allowed to use `process` or `node:*`.
 *
 *   npm run start:node      (or: npm run dev:node)
 *
 * Requires Node >= 24: the global URLPattern, and running .ts files directly.
 * Storage: in memory (swap in SQLite or Redis behind the KvStore interface).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { Readable } from "node:stream";
import { createApp } from "../app.ts";
import { type AppConfig, parseConfig } from "../core/config.ts";
import { trustedClientHeaders } from "../core/request.ts";
import { resolveInside } from "../core/static.ts";
import type { Handler, Logger } from "../core/types.ts";
import { createMemoryKv } from "../stores/memory.ts";
import { adapterErrorResponse, createDeps, fallbackErrorResponse, listenUrl, startupErrorLine } from "./common.ts";

const PUBLIC_DIR = new URL("../../public/", import.meta.url);

/** Server-level timeouts, in milliseconds (the app adds its own per-request timeout). */
const SERVER_TIMEOUTS = { headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000 } as const;

function writeLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

function exitWith(line: string): never {
  writeLine(line);
  process.exit(1);
}

function loadConfig(): AppConfig {
  const result = parseConfig(process.env);
  return result.ok ? result.data : exitWith(startupErrorLine("invalid_config", { errors: result.error }));
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

async function readStatic(path: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const file = resolveInside(PUBLIC_DIR, path);
  if (file === null) return null;
  try {
    return new Uint8Array(await readFile(file));
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "EISDIR") return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// IncomingMessage -> Request
// ---------------------------------------------------------------------------

/** rawHeaders keeps repeated headers as separate name/value pairs. */
function toHeaders(rawHeaders: readonly string[]): Headers {
  const headers = new Headers();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (name !== undefined && value !== undefined && !name.startsWith(":")) headers.append(name, value);
  }
  return headers;
}

function requestUrl(req: IncomingMessage): URL | null {
  const base = `http://${req.headers.host ?? "localhost"}`;
  return URL.canParse(req.url ?? "/", base) ? new URL(req.url ?? "/", base) : null;
}

/**
 * The request body as a web stream. Cancelling `Readable.toWeb(req)` directly
 * would destroy the socket before the response (e.g. a 413) is written, so a
 * cancel here only stops reading; `handle` closes the connection afterwards.
 */
function bodyStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  const reader = (Readable.toWeb(req) as ReadableStream<Uint8Array>).getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      reader.releaseLock();
    },
  });
}

function toRequest(req: IncomingMessage, url: URL, signal: AbortSignal): Request {
  const method = req.method ?? "GET";
  const headers = trustedClientHeaders(toHeaders(req.rawHeaders), req.socket.remoteAddress);
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers, signal });
  const init: RequestInit & { duplex: "half" } = { method, headers, signal, body: bodyStream(req), duplex: "half" };
  return new Request(url, init);
}

// ---------------------------------------------------------------------------
// Response -> ServerResponse
// ---------------------------------------------------------------------------

/** Copies status and headers. `set-cookie` is set as an array so each cookie stays separate. */
function writeHead(res: ServerResponse, response: Response): void {
  res.statusCode = response.status;
  if (response.statusText !== "") res.statusMessage = response.statusText;
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
}

function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

/**
 * Streams the body chunk by chunk, honoring backpressure. If the client goes
 * away, the body is cancelled so its producer (e.g. SSE) can clean up.
 */
async function pipeBody(body: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const reader = body.getReader();
  const cancel = (): void => {
    reader.cancel().catch(() => {});
  };
  res.once("close", cancel);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      if (!res.write(value)) await drained(res);
    }
    if (!res.destroyed) res.end();
  } catch (error) {
    // A body that fails mid-stream must not look like a complete response.
    res.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    res.off("close", cancel);
  }
}

async function writeResponse(res: ServerResponse, response: Response, method: string): Promise<void> {
  writeHead(res, response);
  if (response.body === null || method === "HEAD") {
    await response.body?.cancel();
    res.end();
    return;
  }
  await pipeBody(response.body, res);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function handle(app: Handler, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const aborted = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) aborted.abort();
  });
  // If the app answered without reading the whole body (e.g. 413), close the
  // connection once the response is flushed instead of reading the rest.
  res.once("finish", () => {
    if (!req.complete) req.destroy();
  });
  const url = requestUrl(req);
  const response = url === null
    ? adapterErrorResponse(400, "bad_request", "Invalid request URL")
    : await app(toRequest(req, url, aborted.signal));
  await writeResponse(res, response, req.method ?? "GET");
}

function listener(app: Handler, logger: Logger) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    handle(app, req, res).catch((error: unknown) => {
      logger.error("adapter_error", { error });
      if (res.headersSent) {
        res.destroy();
      } else {
        writeResponse(res, fallbackErrorResponse(), "GET").catch(() => res.destroy());
      }
    });
  };
}

if (typeof globalThis.URLPattern !== "function") {
  exitWith(
    startupErrorLine("unsupported_runtime", {
      reason: `Node ${process.version} has no global URLPattern; use Node >= 24`,
    }),
  );
}

const config = loadConfig();
const deps = createDeps({ config, kv: createMemoryKv(), readStatic, write: writeLine });
const server = createServer(SERVER_TIMEOUTS, listener(createApp(deps), deps.logger));

server.on("error", (error) => {
  deps.logger.error("server_error", { error });
  process.exit(1);
});
server.listen(config.PORT, config.HOST, () => {
  deps.logger.info("server_started", { runtime: "node", url: listenUrl(config.HOST, config.PORT) });
});
