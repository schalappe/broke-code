/**
 * @module apiKey
 * Shape check of an API key typed by the user. The key travels in an HTTP `Authorization` header, which accepts
 * visible ASCII only; a key with any other character would make every request fail before it leaves the machine.
 */

const HEADER_SAFE = /^[\x21-\x7e]*$/;

/** True when `key` (already trimmed) can be sent as a bearer token. Empty = no key, accepted. */
export function isHeaderSafeKey(key: string): boolean {
  return HEADER_SAFE.test(key);
}
