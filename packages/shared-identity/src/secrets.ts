/**
 * Random secrets, their at-rest hashes and constant-time comparison. Every credential
 * Gitstalk issues (session ids, tokens, email-code tickets, challenge handles) is 32 random bytes,
 * shown once, and stored only as its SHA-256.
 */

const encoder = new TextEncoder();

/** 32 random bytes as base64url (43 characters). */
export function randomSecret(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** A prefixed identifier for a row (`u_…`, `tok_…`): 16 random bytes, base32-ish lowercase. */
export function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let id = '';
  for (const byte of bytes) id += alphabet[byte % 32] ?? 'a';
  return `${prefix}_${id}`;
}

/** The SHA-256 of a secret, hex: what the database stores and looks up by. */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * HMAC-SHA-256 of `message` under a server secret, hex. For short secrets (six-digit codes)
 * a plain hash could be reversed by trying every value; without the key it cannot.
 */
export async function hmacHex(key: string, message: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', imported, encoder.encode(message));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `length` uniformly random decimal digits (rejection sampling, so no digit is likelier). */
export function randomDigits(length: number): string {
  const limit = Math.floor(0x1_0000_0000 / 10) * 10;
  let digits = '';
  while (digits.length < length) {
    const [value = limit] = crypto.getRandomValues(new Uint32Array(1));
    if (value < limit) digits += String(value % 10);
  }
  return digits;
}

/**
 * Whether two strings are equal, without an early exit: both sides are hashed to 32 bytes
 * first so the comparison leaks neither content nor length.
 */
export async function isSameSecret(presented: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let difference = x.length ^ y.length;
  for (let index = 0; index < x.length; index += 1) difference |= (x[index] ?? 0) ^ (y[index] ?? 0);
  return difference === 0;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decodes base64url; null when the text is not base64url. */
export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    // atob refused it: not base64url, which the caller treats as absent.
    return null;
  }
}
