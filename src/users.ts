/**
 * Users: zod schemas (the single source of the types) and storage functions
 * that take the KV store as an explicit argument.
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

/** Records by id, for direct lookups. */
const USERS_PREFIX: KvKey = ["users"];

/**
 * The same records keyed so that plain ascending key order (the only order
 * every KV store can list in) is newest first. Lets `listUsers` take the
 * newest N without scanning everything.
 */
const NEWEST_FIRST_PREFIX: KvKey = ["users_by_newest"];

/** Largest timestamp a Date can hold, so `MAX_TIME - t` is never negative. */
const MAX_TIME = 8_640_000_000_000_000;

function userKey(id: string): KvKey {
  return [...USERS_PREFIX, id];
}

export function newestFirstKey(user: User): KvKey {
  const inverted = String(MAX_TIME - Date.parse(user.createdAt)).padStart(16, "0");
  return [...NEWEST_FIRST_PREFIX, `${inverted}_${user.id}`];
}

/** Stored data is re-validated on the way out, so corrupt records never reach clients. */
export function decodeUser(raw: string): User | null {
  const json = parseJsonText(raw);
  if (!json.ok) return null;
  const user = UserSchema.safeParse(json.data);
  return user.success ? user.data : null;
}

/** Writes the record, then its index entry (so a listed user can always be fetched). */
export async function saveUser(kv: KvStore, user: User): Promise<void> {
  const value = JSON.stringify(user);
  await kv.set(userKey(user.id), value);
  await kv.set(newestFirstKey(user), value);
}

export async function findUser(kv: KvStore, id: string): Promise<User | null> {
  const raw = await kv.get(userKey(id));
  return raw === null ? null : decodeUser(raw);
}

/** The newest `limit` users, newest first. */
export async function listUsers(kv: KvStore, limit: number): Promise<User[]> {
  const entries = await kv.list(NEWEST_FIRST_PREFIX, limit);
  return entries.map((entry) => decodeUser(entry.value)).filter((user): user is User => user !== null);
}

/** Removes the index entry, then the record. Resolves to `false` when there was no such user. */
export async function deleteUser(kv: KvStore, id: string): Promise<boolean> {
  const user = await findUser(kv, id);
  if (user === null) return false;
  await kv.delete(newestFirstKey(user));
  await kv.delete(userKey(id));
  return true;
}
