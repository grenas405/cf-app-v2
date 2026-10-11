/**
 * The frontend's pure helpers (public/lib.js), tested without a browser.
 */
import { assertEquals } from "@std/assert";
import {
  connectionLabel,
  countLabel,
  errorMessages,
  formatTimestamp,
  initials,
  isUser,
  parseJsonOrUndefined,
  readCreateInput,
  removeUser,
  upsertUser,
  usersFromResponse,
} from "../public/lib.js";

const ada = { id: "1", name: "Ada", email: "ada@example.com", createdAt: "2026-01-01T00:00:00.000Z" };
const grace = { id: "2", name: "Grace", email: "grace@example.com", createdAt: "2026-01-02T00:00:00.000Z" };

Deno.test("isUser and usersFromResponse keep only well-shaped users", () => {
  assertEquals(isUser(ada), true);
  assertEquals(isUser({ ...ada, id: 1 }), false);
  assertEquals(usersFromResponse({ users: [ada, { nope: true }, null] }), [ada]);
  assertEquals(usersFromResponse({ users: "nope" }), []);
  assertEquals(usersFromResponse(null), []);
});

Deno.test("upsertUser adds, replaces and sorts newest first without mutating", () => {
  const list = [ada];
  assertEquals(upsertUser(list, grace), [grace, ada]);
  assertEquals(upsertUser([grace, ada], { ...ada, name: "Ada L." }).map((u) => u.name), ["Grace", "Ada L."]);
  assertEquals(list, [ada]);
});

Deno.test("removeUser drops by id", () => {
  assertEquals(removeUser([grace, ada], "2"), [ada]);
});

Deno.test("readCreateInput trims form values", () => {
  const form = new Map([["name", "  Ada "], ["email", " ada@example.com "]]);
  assertEquals(readCreateInput(form), { name: "Ada", email: "ada@example.com" });
  assertEquals(readCreateInput(new Map()), { name: "", email: "" });
});

Deno.test("errorMessages labels field issues and falls back to the message", () => {
  assertEquals(
    errorMessages({ issues: [{ path: "email", message: "Invalid email address" }, { path: "", message: "Nope" }] }),
    ["Email: Invalid email address", "Nope"],
  );
  assertEquals(errorMessages({ error: "rate_limited", message: "Too Many Requests" }), ["Too Many Requests"]);
  assertEquals(errorMessages(undefined), ["Something went wrong. Please try again."]);
});

Deno.test("small formatting helpers", () => {
  assertEquals([countLabel(0), countLabel(1), countLabel(2)], ["0 users", "1 user", "2 users"]);
  assertEquals([initials("Ada Lovelace"), initials("  grace  "), initials("Émile Zola Jr")], ["AL", "G", "ÉZ"]);
  assertEquals(formatTimestamp("not a date", "en-US"), "");
  assertEquals(formatTimestamp(ada.createdAt, "en-US").includes("2026"), true);
  assertEquals(connectionLabel("live"), "Live");
  assertEquals([parseJsonOrUndefined('{"a":1}'), parseJsonOrUndefined("{")], [{ a: 1 }, undefined]);
});
