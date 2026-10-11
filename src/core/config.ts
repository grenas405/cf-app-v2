/**
 * Application configuration: one zod schema, parsed once at startup.
 *
 * Adapters read their environment (a side effect) and pass the raw values to
 * `parseConfig`, which is pure. The typed result is handed to the app.
 */
import { z } from "zod";
import type { Result } from "./types.ts";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

function intInRange(min: number, max: number) {
  return z.coerce.number().int().min(min).max(max);
}

/** True when `value` is exactly an http(s) origin: scheme, host, optional port. */
export function isOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const isHttp = url.protocol === "http:" || url.protocol === "https:";
  return isHttp && url.origin === value;
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

const OriginSchema = z
  .string()
  .refine((value) => value !== "*", "Wildcard origins are not allowed; list each origin explicitly")
  .refine(isOrigin, "Must be an origin such as https://example.com (no path or trailing slash)");

const OriginListSchema = z
  .string()
  .default("")
  .transform(splitList)
  .pipe(z.array(OriginSchema).max(50));

export const ConfigSchema = z.object({
  PORT: intInRange(1, 65_535).default(8000),
  HOST: z.string().min(1).max(255).default("127.0.0.1"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  /** Comma-separated list of origins allowed to make cross-origin requests. */
  CORS_ORIGINS: OriginListSchema,
  CORS_ALLOW_CREDENTIALS: z.stringbool().default(false),
  /** Honor X-Forwarded-For / X-Forwarded-Proto. Enable only behind one trusted proxy. */
  TRUST_PROXY: z.stringbool().default(false),
  MAX_BODY_BYTES: intInRange(1, 10 * 1024 * 1024).default(16 * 1024),
  REQUEST_TIMEOUT_MS: intInRange(100, 120_000).default(10_000),
  RATE_LIMIT_MAX: intInRange(1, 1_000_000).default(100),
  RATE_LIMIT_WINDOW_MS: intInRange(1_000, 86_400_000).default(60_000),
  SSE_HEARTBEAT_MS: intInRange(1_000, 60_000).default(15_000),
  /** Bearer token for admin-only routes. Unset means those routes always deny. */
  ADMIN_TOKEN: z.string().min(32).max(512).optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export const CONFIG_KEYS = Object.keys(ConfigSchema.shape) as readonly (keyof AppConfig)[];

/**
 * Keeps only known keys, turns blank values into "unset", and stringifies
 * primitive values (Workers `vars` may be booleans or numbers).
 */
export function pickEnv(env: Readonly<Record<string, unknown>>): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const key of CONFIG_KEYS) {
    picked[key] = toEnvString(env[key]);
  }
  return picked;
}

function toEnvString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * Validates raw environment values. Error messages name the offending key but
 * never include its value, so secrets cannot leak into startup logs.
 */
export function parseConfig(env: Readonly<Record<string, unknown>>): Result<AppConfig, readonly string[]> {
  const result = ConfigSchema.safeParse(pickEnv(env));
  if (result.success) return { ok: true, data: result.data };
  const errors = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return { ok: false, error: errors };
}
