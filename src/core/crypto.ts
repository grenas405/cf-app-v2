/**
 * Small, deterministic crypto helpers built on Web Crypto (`crypto.subtle`).
 */

const encoder = new TextEncoder();

export async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares equal-length byte arrays in time that depends only on their length. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return difference === 0;
}

/**
 * Compares two secrets without leaking, through timing, how long they are or
 * where they first differ: both are hashed to fixed-size digests first.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [hashA, hashB] = await Promise.all([sha256(encoder.encode(a)), sha256(encoder.encode(b))]);
  return constantTimeEqual(hashA, hashB);
}
