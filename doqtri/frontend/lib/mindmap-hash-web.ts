/**
 * lib/mindmap-hash.ts for the browser, where node:crypto is not available:
 * the same SHA-256 of the UTF-8 text, as lowercase hex, through Web Crypto.
 * Asynchronous, as Web Crypto is. Used to decide whether a note's stored map
 * is stale when its row is re-read on the client (DOQ-43); the server still
 * decides it for the rows it renders.
 *
 * TextEncoder, like Node's "utf8" encoding, writes a lone surrogate as U+FFFD,
 * so both digest exactly the same bytes for any string.
 */
export async function hashMarkdownWeb(markdown: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * isMindmapStale() for the browser. A missing hash counts as stale, as there.
 * So does a page where Web Crypto is missing (it needs a secure context):
 * without the digest there is no evidence the map matches the text.
 */
export async function isMindmapStaleWeb(markdown: string, storedHash: string | null | undefined): Promise<boolean> {
  if (!storedHash) return true;
  if (typeof crypto === "undefined" || !crypto.subtle) return true;
  return storedHash !== (await hashMarkdownWeb(markdown));
}
