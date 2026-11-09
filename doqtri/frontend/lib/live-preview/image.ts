import { MAX_LINK_LENGTH } from "@/lib/live-preview/links";

/**
 * Which image URLs the live preview may load.
 *
 * Only absolute `http:` and `https:` URLs. Everything else stays as source:
 * `javascript:` and `data:` have no business loading from a note someone else
 * may have written, relative paths resolve against the app's own routes, and
 * `file:`/`blob:` point at nothing a reader can see. The image itself is then
 * requested with no referrer (see the widget), so a note cannot learn who is
 * reading it from the image host's logs beyond an IP address.
 */
export function loadableImageUrl(raw: string): string | null {
  // The same cap as links (see links.ts): nothing that long is an image address.
  if (raw.length > MAX_LINK_LENGTH) return null;
  const url = raw.trim().replace(/^<(.*)>$/, "$1");
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}
