/**
 * SHA-256 of a string's UTF-8 encoding (no BOM) — the exact bytes a note's
 * content hash is computed over, and the bytes "Download anchored .md" writes.
 */
export async function sha256Hex(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text));
}

/** SHA-256 of raw bytes, e.g. a file dropped on the public audit page. */
export async function sha256HexBytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "").toLowerCase();
  if (clean.length !== 64) {
    throw new Error("content hash must be 32 bytes (64 hex chars)");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
