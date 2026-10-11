// @ts-check
/**
 * Pure helpers for the frontend: data in, data out. No DOM, no network.
 * Unit-tested from tests/frontend_test.ts.
 */

/** @typedef {{ id: string, name: string, email: string, createdAt: string }} User */
/** @typedef {"connecting" | "live" | "offline"} ConnectionState */

const GENERIC_ERROR = "Something went wrong. Please try again.";

/** @type {Readonly<Record<string, string>>} */
const FIELD_LABELS = { name: "Name", email: "Email" };

/** @type {Readonly<Record<ConnectionState, string>>} */
const CONNECTION_LABELS = { connecting: "Connecting…", live: "Live", offline: "Reconnecting…" };

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * Checks the shape of API data before it is rendered.
 * @param {unknown} value
 * @returns {value is User}
 */
export function isUser(value) {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.email === "string" &&
    typeof value.createdAt === "string";
}

/**
 * @param {unknown} body
 * @returns {User[]}
 */
export function usersFromResponse(body) {
  const users = isRecord(body) ? body.users : undefined;
  return Array.isArray(users) ? users.filter(isUser) : [];
}

/**
 * @param {string} text
 * @returns {unknown} the parsed value, or undefined if `text` is not JSON
 */
export function parseJsonOrUndefined(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Newest first; ties broken by id so the order is stable.
 * @param {User} a
 * @param {User} b
 */
export function compareNewestFirst(a, b) {
  return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Adds or replaces `user`, returning a new sorted array.
 * @param {readonly User[]} users
 * @param {User} user
 * @returns {User[]}
 */
export function upsertUser(users, user) {
  return [user, ...users.filter((existing) => existing.id !== user.id)].sort(compareNewestFirst);
}

/**
 * @param {readonly User[]} users
 * @param {string} id
 * @returns {User[]}
 */
export function removeUser(users, id) {
  return users.filter((user) => user.id !== id);
}

/**
 * @param {{ get(name: string): unknown }} form e.g. a FormData
 * @returns {{ name: string, email: string }}
 */
export function readCreateInput(form) {
  return {
    name: String(form.get("name") ?? "").trim(),
    email: String(form.get("email") ?? "").trim(),
  };
}

/**
 * @param {unknown} issue
 * @returns {string}
 */
function issueMessage(issue) {
  if (!isRecord(issue)) return GENERIC_ERROR;
  const text = typeof issue.message === "string" ? issue.message : "Invalid value";
  const label = typeof issue.path === "string" ? FIELD_LABELS[issue.path] : undefined;
  return label === undefined ? text : `${label}: ${text}`;
}

/**
 * Turns an API error body into messages for people.
 * @param {unknown} body
 * @returns {string[]}
 */
export function errorMessages(body) {
  if (!isRecord(body)) return [GENERIC_ERROR];
  if (Array.isArray(body.issues) && body.issues.length > 0) return body.issues.map(issueMessage);
  return [typeof body.message === "string" ? body.message : GENERIC_ERROR];
}

/**
 * @param {number} count
 * @returns {string}
 */
export function countLabel(count) {
  return count === 1 ? "1 user" : `${count} users`;
}

/**
 * Up to two initials, e.g. "Ada Lovelace" → "AL".
 * @param {string} name
 * @returns {string}
 */
export function initials(name) {
  return name
    .split(/\s+/)
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase();
}

/**
 * @param {string} iso
 * @param {string | undefined} locale
 * @returns {string}
 */
export function formatTimestamp(iso, locale) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/**
 * @param {ConnectionState} state
 * @returns {string}
 */
export function connectionLabel(state) {
  return CONNECTION_LABELS[state];
}
