/**
 * Node's Buffer pooling means small buffers (`Buffer.from(text)`, `Buffer.concat(...)`, a
 * serialized message) are often views into a much larger shared ArrayBuffer. WebCrypto's
 * `subtle.sign` and `subtle.verify` read the view's backing buffer rather than respecting
 * its byteOffset/byteLength, which silently signs or verifies the wrong bytes. Copy into a
 * tightly-sized Uint8Array before either.
 */
export function exactBytes(bytes: Uint8Array): Uint8Array {
  return bytes.byteLength === bytes.buffer.byteLength ? bytes : Uint8Array.from(bytes);
}

/** The UTF-8 bytes of `text`, tightly sized. */
export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
