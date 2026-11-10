import { describe, expect, it } from "vitest";
import { hashMarkdown, isMindmapStale } from "@/lib/mindmap-hash";
import { hashMarkdownWeb, isMindmapStaleWeb } from "@/lib/mindmap-hash-web";

// The browser decides staleness of a re-read row (DOQ-43) against hashes the
// server stored, so both must digest every string to the same hex.
const SAMPLES = [
  "",
  "# Title\n\nBody.\n",
  "Ünïcödé — “quotes”, 日本語, emoji 🧭🗺️, combining é",
  "line\r\nendings\rmixed\n",
  // A lone surrogate: both encoders write U+FFFD for it.
  "broken \uD83D pair and \uDE00 tail",
  "x".repeat(100_000),
];

describe("hashMarkdownWeb", () => {
  it.each(SAMPLES.map((text) => [text.slice(0, 24), text]))("matches node:crypto for %j", async (_, text) => {
    expect(await hashMarkdownWeb(text)).toBe(hashMarkdown(text));
  });

  it("decides staleness as the server does", async () => {
    const text = "# Map\n\n## Theme\n";
    for (const stored of [hashMarkdown(text), hashMarkdown(`${text}more`), null, undefined, ""]) {
      expect(await isMindmapStaleWeb(text, stored)).toBe(isMindmapStale(text, stored));
    }
  });
});
