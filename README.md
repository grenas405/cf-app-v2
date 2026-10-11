# cf-app-v2

A small, runtime-agnostic HTTP server starter in TypeScript. The whole application is one function:

```ts
type Handler = (req: Request) => Promise<Response>;
```

It is built only on Web standard APIs (Fetch, URL, URLPattern, Headers, ReadableStream, TextEncoder, `crypto.subtle`)
and runs unchanged on **Deno**, **Bun**, **Node** (`node:http`) and **Cloudflare Workers**. A minimal frontend, styled
with Tailwind CSS v4, is served by the same server.

The only runtime dependency is [zod](https://zod.dev). Tailwind is a build-time dependency.

## Quick start

```sh
deno task dev                          # Deno: CSS watcher + auto-restarting server on :8000
npm install && npm run dev:node        # Node >= 24
bun install && bun run dev:bun         # Bun >= 1.3
npm install && npm run dev:worker      # Cloudflare Workers (wrangler dev)
```

Open <http://127.0.0.1:8000> (Workers: <http://127.0.0.1:8787>). Configuration comes from environment variables; see
[Configuration](#configuration).

## Layout

```
src/
  core/                  runtime-agnostic, no side effects of its own
    types.ts             Handler, Middleware, Deps and the storage/clock/logger interfaces
    router.ts            URLPattern router: routes are data, matching is a pure function
    middleware.ts        compose + logger, error boundary, CORS, security headers,
                         timeout, rate limit, body limit, auth hook
    http.ts              pure response helpers (json, text, notFound, badRequest, …)
    validate.ts          zod helpers: parseJson / parseQuery / parseParams → Result
    static.ts            path sanitizing, Content-Type, cache headers, ETags
    config.ts            the config schema, parsed once at startup
    auth.ts, crypto.ts, log.ts, request.ts, sse.ts
  routes/                one file per concern: users, events (SSE), static, health
  users.ts               user schemas (types come from z.infer) and KV access
  stores/memory.ts       in-memory KV, rate-limit counters and event bus
  app.ts                 createApp(deps): wires routes and middleware
  adapters/
    deno.ts bun.ts node.ts worker.ts   the only files with runtime-specific code
    common.ts            shared adapter helpers (Web-standard globals only)
public/                  served as-is: index.html, app.js, lib.js, favicon.svg, styles.css (built)
frontend/styles.css      Tailwind entry point
tests/                   Deno tests that call app(new Request(...)) directly
```

## The core/adapter split

`createApp(deps)` returns the handler. It imports nothing runtime-specific, so the same code runs everywhere and in
tests.

Each adapter is a thin entry point that does exactly three things:

1. **Reads and validates config** with the shared zod schema, and exits loudly (Workers: answers 500 and logs) on
   invalid values. Error messages name the key and never echo its value.
2. **Builds real dependencies**: storage, a log writer, `readStatic`, and the clock, timers and id generator.
3. **Starts the server** and converts between the platform and Fetch `Request`/`Response` where needed (Node).

Anything that mentions `Deno.`, `Bun.`, `process` or `node:` lives only in `src/adapters/`.

| Runtime | Storage                 | Static files       | Client IP from             |
| ------- | ----------------------- | ------------------ | -------------------------- |
| Deno    | Deno KV (persistent)    | `Deno.readFile`    | `info.remoteAddr`          |
| Bun     | in-memory               | `Bun.file`         | `server.requestIP()`       |
| Node    | in-memory               | `node:fs/promises` | `req.socket.remoteAddress` |
| Workers | KV namespace `USERS_KV` | `ASSETS` binding   | `CF-Connecting-IP`         |

To use Redis, SQLite, D1 or anything else, implement the four-method `KvStore` interface in the adapter. Nothing else
changes.

## Side effects at the edges

The core takes inputs and returns outputs. Everything that touches the outside world arrives through `Deps`:

```ts
interface Deps {
  config: AppConfig; // validated once, at startup
  kv: KvStore; // storage
  rateLimitStore: RateLimitStore; // rate-limit counters
  logger: Logger; // writes through an injected (line: string) => void
  clock: Clock; // now(), after(), every(): time and timers
  newId: () => string; // randomness
  events: EventBus; // pub/sub feeding server-sent events
  readStatic: ReadStatic; // file reads
}
```

The core never calls `Date.now()`, `setTimeout`, `crypto.randomUUID()`, `console` or the file system. Each middleware
and route factory receives only the dependencies it uses (for example `rateLimit({ store, clock, logger, … })`), so it
can be read and tested on its own.

This is why the tests need no server, no network and no permissions. `deno task test` runs with every permission denied.
A fake clock fires timers on demand, and a fake `readStatic` records every path it is asked for.

## Request pipeline

Middleware is `(next: Handler) => Handler`; `compose(a, b, c)` runs a → b → c → router. The order in `src/app.ts`:

1. **securityHeaders**: every response, including errors and rejections, gets the headers.
2. **requestLogger**: one line per request at `debug`, so it is silent by default.
3. **errorBoundary**: any throw becomes a generic 500 carrying an `errorId`; details go only to the log.
4. **cors**: answers preflights and rejects disallowed origins before any work is done.
5. **timeout**: 503 if no response arrives within `REQUEST_TIMEOUT_MS`.
6. **rateLimit**: a cheap counter check before the body is read; `/health` is exempt.
7. **bodyLimit**: rejects oversized bodies before anything parses them.
8. **router**: plus route-level middleware such as the auth hook on `DELETE /users/:id`.

## Routes

| Method   | Path         | Notes                                                               |
| -------- | ------------ | ------------------------------------------------------------------- |
| `GET`    | `/health`    | `{ "ok": true }`                                                    |
| `GET`    | `/users`     | `?limit=1..100`, newest first                                       |
| `POST`   | `/users`     | JSON `{ name, email }`, strict schema, `201` + `Location`           |
| `GET`    | `/users/:id` | `id` must be a UUID                                                 |
| `DELETE` | `/users/:id` | needs `Authorization: Bearer $ADMIN_TOKEN`                          |
| `GET`    | `/events`    | server-sent events: `ready`, `ping`, `user.created`, `user.deleted` |
| `GET`    | `/*`         | static files from `public/` (`/` → `index.html`)                    |

Errors always use one JSON shape: `{ "error": "code", "message": "…", ...details }`. A validation failure is a 400 that
lists each issue:

```json
{
  "error": "validation_failed",
  "message": "Invalid request body",
  "issues": [{ "path": "email", "code": "invalid_format", "message": "Enter a valid email address" }]
}
```

## Unix philosophy, applied

- **Do one thing well.** Every middleware is a separate factory, and every route lives in its own file. Validation,
  static-path rules and response building are separate pure modules.
- **Compose small pieces.** The app is `compose(...middleware)(router)`. Route-level middleware (auth) uses the same
  shape.
- **Plain interfaces.** Functions take data and return data. Logs are line-delimited JSON on stderr (stdout on Workers).
- **Fail loudly and early, be quiet on success.** Bad config stops startup with a clear error. Successful requests log
  nothing at the default `info` level; security events log at `warn`.
- **Minimal, replaceable dependencies.** zod and Tailwind only. Storage, clock and logging are interfaces with in-memory
  defaults.

## OWASP controls

| Control                              | Where                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Allowlist validation of all input    | zod `.strict()` schemas for body, params and query; Unicode-aware name allowlist                                                      |
| Request size limit before parsing    | `bodyLimit`: Content-Length first, then a byte counter for chunked bodies                                                             |
| No internals in errors               | `errorBoundary`: generic 500 + `errorId`, stack only in the server log                                                                |
| Security headers                     | strict CSP (no inline script or style), nosniff, `Referrer-Policy`, `X-Frame-Options` + `frame-ancestors`, COOP/CORP, HSTS over HTTPS |
| CORS                                 | exact-origin allowlist from config; `*` is rejected at startup                                                                        |
| Secrets                              | only from validated config; never logged; sensitive log keys redacted                                                                 |
| Constant-time token comparison       | `timingSafeEqual`: SHA-256 both sides, then compare in constant time                                                                  |
| Authentication hook                  | `requireAuth({ authenticate })`; `bearerTokenAuth` fails closed if unset                                                              |
| Rate limiting                        | `rateLimit` on an injected `RateLimitStore`; returns 429 + `Retry-After`                                                              |
| Timeouts                             | per-request `timeout` middleware, plus server timeouts in the Node and Bun adapters                                                   |
| Correct Content-Type, encoded output | every helper sets Content-Type; the frontend only uses `textContent`                                                                  |
| Path traversal                       | `sanitizeStaticPath` allowlist + `resolveInside` check in each adapter                                                                |
| Security event logging               | `validation_failed`, `auth_failed`, `rate_limited`, `cors_origin_denied`, `body_too_large`, `static_path_rejected`                    |

Outbound calls: the app makes none. If you add some, inject `fetch` through `Deps` and pass `AbortSignal.timeout(ms)`.

Client IP: an adapter writes the socket address into an internal header and always overwrites any client-supplied value.
`X-Forwarded-For` and `X-Forwarded-Proto` are honored only with `TRUST_PROXY=true`. Enable that only behind exactly one
trusted proxy.

## Frontend and Tailwind

`public/index.html` lists users and has a form to create one. The JS is plain ES modules, type-checked with JSDoc
(`// @ts-check`) and no build step:

- `public/lib.js` holds the pure helpers (shape checks, sorting, error messages, formatting). They are unit-tested in
  `tests/frontend_test.ts`.
- `public/app.js` holds the edges: `fetch` calls, DOM updates and the `EventSource`. Rows are cloned from a `<template>`
  and filled with `textContent`; `innerHTML` is never used for data.

Tailwind CSS v4 is compiled at build time by the Tailwind CLI (`@tailwindcss/cli`) from `frontend/styles.css` into
`public/styles.css`. The CDN/play script is not used, because it injects inline styles that the strict CSP would block.
Automatic source detection is off; `@source` lists exactly the files to scan.

```sh
deno task build:css   # or: npm run build:css      one-off, minified
deno task dev:css     # or: npm run watch:css      rebuild on change
```

`public/styles.css` is generated and git-ignored. The `start` and `dev` scripts build it first.

## Running each runtime

**Deno** (2.x)

```sh
deno task dev     # watch mode
deno task start   # build CSS, then serve
```

Permissions are scoped: `--allow-net --allow-env --allow-read=public`. `--unstable-kv` enables Deno KV, which persists
in Deno's cache directory.

**Node** (>= 24, which provides the global `URLPattern` and runs `.ts` files directly)

```sh
npm install
npm run dev:node      # or: npm run start:node
```

**Bun** (>= 1.3)

```sh
bun install
bun run dev:bun       # or: bun run start:bun
```

**Cloudflare Workers**

```sh
npm install
npx wrangler@4 kv namespace create USERS_KV    # put the id in wrangler.jsonc
npx wrangler@4 secret put ADMIN_TOKEN          # optional
npm run dev:worker                             # local (workerd)
npm run deploy:worker
```

Static files go through the `ASSETS` binding with `run_worker_first`, so they get the same headers and checks. On
Workers, rate-limit counters and SSE subscribers live per isolate, so they are best effort. Use a Durable Object or the
Rate Limiting binding behind the same interfaces for global guarantees.

The `dev:*` npm scripts use `&` to run the CSS watcher alongside the server, so they need a POSIX shell. `deno task dev`
works everywhere.

## Configuration

All variables are optional and validated at startup; blank means "use the default". Export them in your shell or load a
`.env` file: Bun loads it automatically, Deno and Node need `--env-file`, and Workers read `.dev.vars` locally. See
`.env.example`.

| Variable                 | Default             | Notes                                                  |
| ------------------------ | ------------------- | ------------------------------------------------------ |
| `PORT`, `HOST`           | `8000`, `127.0.0.1` | use `HOST=0.0.0.0` in containers                       |
| `LOG_LEVEL`              | `info`              | `debug` adds one line per request                      |
| `CORS_ORIGINS`           | (none)              | comma-separated exact origins; `*` is rejected         |
| `CORS_ALLOW_CREDENTIALS` | `false`             |                                                        |
| `TRUST_PROXY`            | `false`             | honor `X-Forwarded-*` from one trusted proxy           |
| `MAX_BODY_BYTES`         | `16384`             |                                                        |
| `REQUEST_TIMEOUT_MS`     | `10000`             |                                                        |
| `RATE_LIMIT_MAX`         | `100`               | requests per window per client IP                      |
| `RATE_LIMIT_WINDOW_MS`   | `60000`             |                                                        |
| `SSE_HEARTBEAT_MS`       | `15000`             | 1–60 s                                                 |
| `ADMIN_TOKEN`            | (unset)             | ≥ 32 chars; unset means admin routes always return 401 |

## Tests and checks

```sh
deno task test    # 138 tests, no permissions: routing, validation, middleware, security, SSE, frontend, Worker adapter
deno task check   # type-checks src/ (all four adapters), tests/ and the frontend JS
deno task lint    # deno lint + deno fmt --check
```

Tests call `app(new Request(...))` with in-memory fakes. The security suite covers:

- oversized and chunked bodies
- unknown fields
- disallowed origins
- headers on every response type
- rate limiting, including spoofed `X-Forwarded-For`
- encoded path-traversal attempts, which never reach the file reader
- 500s with no stack trace
- secrets kept out of logs

## License

MIT
