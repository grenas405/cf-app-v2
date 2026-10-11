// @ts-check
/// <reference lib="dom" />
/**
 * Browser entry point. Network calls and DOM updates live here, at the edge;
 * what they show is computed by the pure helpers in lib.js.
 *
 * API data is only ever inserted with textContent, never innerHTML.
 */
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
} from "./lib.js";

/** @typedef {import("./lib.js").User} User */
/** @typedef {import("./lib.js").ConnectionState} ConnectionState */
/** @typedef {{ ok: true, user: User } | { ok: false, messages: string[] }} CreateResult */

// ---------------------------------------------------------------------------
// Network (edge)
// ---------------------------------------------------------------------------

/**
 * @param {typeof fetch} fetchFn
 * @returns {Promise<User[]>}
 */
async function fetchUsers(fetchFn) {
  const response = await fetchFn("/users", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET /users failed with status ${response.status}`);
  return usersFromResponse(await response.json());
}

/**
 * @param {typeof fetch} fetchFn
 * @param {{ name: string, email: string }} input
 * @returns {Promise<CreateResult>}
 */
async function postUser(fetchFn, input) {
  const response = await fetchFn("/users", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => undefined);
  return response.ok && isUser(body) ? { ok: true, user: body } : { ok: false, messages: errorMessages(body) };
}

// ---------------------------------------------------------------------------
// DOM (edge)
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   form: HTMLFormElement,
 *   submit: HTMLButtonElement,
 *   errors: HTMLUListElement,
 *   list: HTMLUListElement,
 *   empty: HTMLElement,
 *   count: HTMLElement,
 *   connection: HTMLElement,
 *   template: HTMLTemplateElement,
 * }} Elements
 */

/**
 * @template {Element} T
 * @param {ParentNode} root
 * @param {string} selector
 * @param {{ new (): T }} type
 * @returns {T}
 */
function find(root, selector, type) {
  const element = root.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`Missing element: ${selector}`);
  return element;
}

/**
 * @param {Document} doc
 * @returns {Elements}
 */
function findElements(doc) {
  return {
    form: find(doc, "#create-user", HTMLFormElement),
    submit: find(doc, "#create-user button[type=submit]", HTMLButtonElement),
    errors: find(doc, "#form-errors", HTMLUListElement),
    list: find(doc, "#user-list", HTMLUListElement),
    empty: find(doc, "#empty-state", HTMLElement),
    count: find(doc, "#user-count", HTMLElement),
    connection: find(doc, "#connection", HTMLElement),
    template: find(doc, "#user-row", HTMLTemplateElement),
  };
}

/**
 * @param {ParentNode} root
 * @param {string} field
 * @param {string} text
 */
function setField(root, field, text) {
  find(root, `[data-field="${field}"]`, HTMLElement).textContent = text;
}

/**
 * @param {HTMLTemplateElement} template
 * @param {User} user
 * @param {string | undefined} locale
 * @returns {DocumentFragment}
 */
function userRow(template, user, locale) {
  const row = /** @type {DocumentFragment} */ (template.content.cloneNode(true));
  setField(row, "initials", initials(user.name));
  setField(row, "name", user.name);
  setField(row, "email", user.email);
  const created = find(row, '[data-field="created"]', HTMLTimeElement);
  created.dateTime = user.createdAt;
  created.textContent = formatTimestamp(user.createdAt, locale);
  return row;
}

/**
 * @param {Elements} elements
 * @param {readonly User[]} users
 * @param {string | undefined} locale
 */
function renderUsers(elements, users, locale) {
  elements.list.replaceChildren(...users.map((user) => userRow(elements.template, user, locale)));
  elements.list.hidden = users.length === 0;
  elements.empty.hidden = users.length > 0;
  elements.count.textContent = countLabel(users.length);
}

/**
 * @param {HTMLUListElement} list
 * @param {readonly string[]} messages
 */
function renderErrors(list, messages) {
  const items = messages.map((message) => {
    const item = list.ownerDocument.createElement("li");
    item.textContent = message;
    return item;
  });
  list.replaceChildren(...items);
  list.hidden = messages.length === 0;
}

/**
 * @param {HTMLElement} badge
 * @param {ConnectionState} state
 */
function renderConnection(badge, state) {
  badge.dataset.state = state;
  setField(badge, "label", connectionLabel(state));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   document: Document,
 *   fetch: typeof fetch,
 *   EventSource: typeof EventSource,
 *   locale: string | undefined,
 * }} env
 */
function main(env) {
  const elements = findElements(env.document);
  /** @type {User[]} */
  let users = [];
  /** @type {ConnectionState} */
  let connection = "connecting";

  /** @param {User[]} next */
  const showUsers = (next) => {
    users = next;
    renderUsers(elements, users, env.locale);
  };

  /** @param {ConnectionState} next */
  const showConnection = (next) => {
    connection = next;
    renderConnection(elements.connection, connection);
  };

  const refresh = () =>
    fetchUsers(env.fetch)
      .then(showUsers)
      .catch(() => renderErrors(elements.errors, ["Could not load users. Is the server running?"]));

  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.submit.disabled = true;
    renderErrors(elements.errors, []);
    try {
      const result = await postUser(env.fetch, readCreateInput(new FormData(elements.form)));
      if (result.ok) {
        showUsers(upsertUser(users, result.user));
        elements.form.reset();
      } else {
        renderErrors(elements.errors, result.messages);
      }
    } catch {
      renderErrors(elements.errors, ["Network error. Please try again."]);
    } finally {
      elements.submit.disabled = false;
    }
  });

  const events = new env.EventSource("/events");
  events.addEventListener("ready", () => {
    // After a reconnect we may have missed events; reload the list once.
    if (connection === "offline") refresh();
    showConnection("live");
  });
  events.addEventListener("ping", () => showConnection("live"));
  events.addEventListener("error", () => showConnection("offline"));
  events.addEventListener("user.created", (event) => {
    const user = parseJsonOrUndefined(event.data);
    if (isUser(user)) showUsers(upsertUser(users, user));
  });
  events.addEventListener("user.deleted", (event) => {
    const data = parseJsonOrUndefined(event.data);
    const id = typeof data === "object" && data !== null && "id" in data ? data.id : undefined;
    if (typeof id === "string") showUsers(removeUser(users, id));
  });

  refresh();
}

main({
  document,
  fetch: globalThis.fetch.bind(globalThis),
  EventSource: globalThis.EventSource,
  locale: navigator.language,
});
