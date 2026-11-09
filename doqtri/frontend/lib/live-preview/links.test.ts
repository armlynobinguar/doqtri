import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { linkAt, openableLinkUrl } from "@/lib/live-preview/links";
import { previewParser } from "@/lib/live-preview/syntax";

function at(source: string, needle: string, offset = 1) {
  const doc = Text.of(source.split("\n"));
  return linkAt(previewParser.parse(source), doc, source.indexOf(needle) + offset);
}

describe("openableLinkUrl", () => {
  it("opens http, https and mailto only", () => {
    expect(openableLinkUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(openableLinkUrl("HTTP://example.com")).toBe("http://example.com/");
    expect(openableLinkUrl("mailto:someone@example.com")).toBe("mailto:someone@example.com");
    expect(openableLinkUrl("www.example.com")).toBe("https://www.example.com/");
    expect(openableLinkUrl("someone@example.com")).toBe("mailto:someone@example.com");
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "/vault/settings",
      "relative/path",
      "//evil.example",
      "file:///etc/passwd",
      "vbscript:x",
      "https://",
      "mailto:",
      "ftp://example.com",
    ]) {
      expect(openableLinkUrl(url), url).toBeNull();
    }
  });
});

describe("linkAt", () => {
  it("finds a markdown link's address from anywhere in it", () => {
    const text = "see [the docs](https://example.com) now";
    expect(at(text, "the docs")).toEqual({ kind: "url", url: "https://example.com/" });
    expect(at(text, "example.com")).toEqual({ kind: "url", url: "https://example.com/" });
  });

  it("finds a wikilink's note, alias or not", () => {
    expect(at("see [[Other note]] now", "Other")).toEqual({ kind: "wiki", title: "Other note" });
    expect(at("see [[Target|shown]] now", "shown")).toEqual({ kind: "wiki", title: "Target" });
  });

  it("finds autolinks and bare URLs", () => {
    expect(at("<https://a.example>", "a.example")).toEqual({ kind: "url", url: "https://a.example/" });
    expect(at("go to https://b.example today", "b.example")).toEqual({ kind: "url", url: "https://b.example/" });
  });

  it("refuses addresses that must not open, and is null off a link", () => {
    expect(at("[click](javascript:alert(1))", "click")).toBeNull();
    expect(at("[rel](/vault/x)", "rel")).toBeNull();
    expect(at("a [note] here", "note")).toBeNull();
    expect(at("plain text here", "text")).toBeNull();
    expect(at("![img](https://x.example/a.png)", "img")).toBeNull();
  });
});
