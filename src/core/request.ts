/**
 * Pure facts about a request: its path, client address and scheme.
 *
 * The client IP is not part of the Fetch API's Request, so each adapter
 * copies it into a header with `withClientIp`. The adapter always overwrites
 * that header, so a client cannot spoof it by sending its own.
 */

export const CLIENT_IP_HEADER = "x-client-ip";

export function pathOf(req: Request): string {
  return new URL(req.url).pathname;
}

/** Returns a copy of `headers` whose client-IP header holds `ip` (or is removed). */
export function trustedClientHeaders(headers: Headers, ip: string | undefined): Headers {
  const copy = new Headers(headers);
  if (ip === undefined || ip === "") {
    copy.delete(CLIENT_IP_HEADER);
  } else {
    copy.set(CLIENT_IP_HEADER, ip);
  }
  return copy;
}

export function withClientIp(req: Request, ip: string | undefined): Request {
  return new Request(req, { headers: trustedClientHeaders(req.headers, ip) });
}

/** Last entry of a comma-separated header: the one our own proxy appended. */
function lastListItem(value: string | null): string | undefined {
  const item = value?.split(",").at(-1)?.trim();
  return item === "" ? undefined : item;
}

/**
 * The client address used for rate limiting. With `trustProxy`, the address
 * appended to X-Forwarded-For by the (single) trusted proxy wins.
 */
export function clientIp(req: Request, trustProxy: boolean): string {
  const forwarded = trustProxy ? lastListItem(req.headers.get("x-forwarded-for")) : undefined;
  return forwarded ?? req.headers.get(CLIENT_IP_HEADER) ?? "unknown";
}

export function isHttps(req: Request, trustProxy: boolean): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  return trustProxy && lastListItem(req.headers.get("x-forwarded-proto"))?.toLowerCase() === "https";
}
