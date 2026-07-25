import { createHash } from "node:crypto";

/**
 * The digest stored alongside a generated mindmap.
 *
 * Server-only on purpose: it uses `node:crypto` so it stays synchronous, and
 * staleness is decided on the server and handed to the client as a boolean.
 * Importing this from a client component would pull Node built-ins into the
 * browser bundle.
 */
export function hashMarkdown(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

/**
 * Whether a stored mindmap still describes the current markdown.
 *
 * A missing hash counts as stale: the map exists but there is no evidence of
 * what it was built from, so the honest answer is "regenerate to be sure".
 */
export function isMindmapStale(
  markdown: string,
  storedHash: string | null | undefined,
): boolean {
  if (!storedHash) return true;
  return storedHash !== hashMarkdown(markdown);
}
