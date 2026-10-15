import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Ring signs every webhook with HMAC-SHA256 over the raw request body, hex-encoded,
 * sent as `X-Signature: sha256=<hex>`. The same HMAC key is used for account-linking
 * nonces, but those use URL-safe Base64 instead. Do not mix the two encodings.
 *
 * Docs: https://developer.amazon.com/docs/ring/api-documentation.html#webhook-authentication--verification
 */
export const SIGNATURE_HEADER = 'x-signature';
const PREFIX = 'sha256=';

export function signBody(rawBody: string | Uint8Array, hmacKey: string): string {
  const mac = createHmac('sha256', hmacKey).update(rawBody).digest('hex');
  return `${PREFIX}${mac}`;
}

/**
 * Constant-time verification. Always pass the raw bytes you received, never a
 * re-serialised JSON object: key order or whitespace changes break the signature.
 */
export function verifySignature(
  rawBody: string | Uint8Array,
  header: string | undefined | null,
  hmacKey: string,
): boolean {
  if (!header || !header.startsWith(PREFIX)) return false;
  const expected = Buffer.from(signBody(rawBody, hmacKey));
  const received = Buffer.from(header.trim());
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
