/**
 * Users: zod schemas (the single source of the types), the `UserStore`
 * interface the routes depend on, and its KV-backed implementation. The D1
 * implementation lives in the Workers adapter.
 */
import { z } from "zod";
import type { KvKey, KvStore } from "./core/types.ts";
import { parseJsonText } from "./core/validate.ts";

/**
 * Letters, marks and digits from any script, plus space . , ' ’ - and starting
 * with a letter or digit. The empty string is left to `.min(1)` to report.
 */
const NAME_PATTERN = /^(?:[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’-]*)?$/u;

export const UserIdSchema = z.uuid();

export const UserNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(100, "Name must be at most 100 characters")
  .regex(NAME_PATTERN, "Name may only contain letters, numbers, spaces and . , ' -");

export const EmailSchema = z.email("Enter a valid email address").max(254, "Email must be at most 254 characters");

export const CreateUserSchema = z.object({
  name: UserNameSchema,
  email: EmailSchema,
}).strict();

export const UserSchema = z.object({
  id: UserIdSchema,
  name: UserNameSchema,
  email: EmailSchema,
  createdAt: z.iso.datetime(),
}).strict();

export const UserParamsSchema = z.object({ id: UserIdSchema }).strict();

export const ListUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type User = z.infer<typeof UserSchema>;

export function buildUser(input: CreateUserInput, id: string, now: number): User {
  return { id, name: input.name, email: input.email, createdAt: new Date(now).toISOString() };
}

export type CreateUserResult = "created" | "email_taken";

/** Storage for user records. Each adapter picks the backend. */
export interface UserStore {
  /** Saves a new user unless its email (compared case-insensitively) is already taken. */
  create(user: User): Promise<CreateUserResult>;
  find(id: string): Promise<User | null>;
  /** The newest `limit` users, newest first. */
  listNewest(limit: number): Promise<User[]>;
  /** Resolves to `false` when there was no such user. */
  delete(id: string): Promise<boolean>;
}

/** Validates a stored record (a parsed JSON value or a database row), so corrupt data never reaches clients. */
export function toUser(value: unknown): User | null {
  const user = UserSchema.safeParse(value);
  return user.success ? user.data : null;
}

export function decodeUser(raw: string): User | null {
  const json = parseJsonText(raw);
  return json.ok ? toUser(json.data) : null;
}

function isUser(user: User | null): user is User {
  return user !== null;
}

// ---------------------------------------------------------------------------
// KV-backed store (Deno KV, in-memory, or any other KvStore)
// ---------------------------------------------------------------------------

/** Records by id, for direct lookups. */
const USERS_PREFIX: KvKey = ["users"];

/**
 * The same records keyed so that plain ascending key order (the only order
 * every KV store can list in) is newest first. Lets `listNewest` take the
 * newest N without scanning everything.
 */
const NEWEST_FIRST_PREFIX: KvKey = ["users_by_newest"];

/** One entry per email, claimed atomically to keep emails unique. */
const EMAIL_PREFIX: KvKey = ["users_by_email"];

/** Largest timestamp a Date can hold, so `MAX_TIME - t` is never negative. */
const MAX_TIME = 8_640_000_000_000_000;

function userKey(id: string): KvKey {
  return [...USERS_PREFIX, id];
}

export function newestFirstKey(user: User): KvKey {
  const inverted = String(MAX_TIME - Date.parse(user.createdAt)).padStart(16, "0");
  return [...NEWEST_FIRST_PREFIX, `${inverted}_${user.id}`];
}

function emailKey(email: string): KvKey {
  return [...EMAIL_PREFIX, email.toLowerCase()];
}

async function findInKv(kv: KvStore, id: string): Promise<User | null> {
  const raw = await kv.get(userKey(id));
  return raw === null ? null : decodeUser(raw);
}

export function createKvUserStore(kv: KvStore): UserStore {
  return {
    // Claims the email first; then writes the record before its index entry,
    // so a listed user can always be fetched.
    create: async (user) => {
      if (!(await kv.setIfAbsent(emailKey(user.email), user.id))) return "email_taken";
      const value = JSON.stringify(user);
      await kv.set(userKey(user.id), value);
      await kv.set(newestFirstKey(user), value);
      return "created";
    },
    find: (id) => findInKv(kv, id),
    listNewest: async (limit) => {
      const entries = await kv.list(NEWEST_FIRST_PREFIX, limit);
      return entries.map((entry) => decodeUser(entry.value)).filter(isUser);
    },
    // Reverse order of `create`: the email is released last.
    delete: async (id) => {
      const user = await findInKv(kv, id);
      if (user === null) return false;
      await kv.delete(newestFirstKey(user));
      await kv.delete(userKey(id));
      await kv.delete(emailKey(user.email));
      return true;
    },
  };
}
