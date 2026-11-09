import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { linkAt, MAX_LINK_LENGTH, openableLinkUrl } from "@/lib/live-preview/links";
import { loadableImageUrl } from "@/lib/live-preview/image";
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

describe("openableLinkUrl edge cases", () => {
  it("leaves a URL with a scheme alone, @ in its path or not", () => {
    expect(openableLinkUrl("https://medium.com/@john.doe/my-post")).toBe("https://medium.com/@john.doe/my-post");
    expect(openableLinkUrl("https://www.google.com/maps/@51.5,-0.12,15z")).toBe(
      "https://www.google.com/maps/@51.5,-0.12,15z",
    );
  });

  it("refuses credentials in front of the host, which hide where it goes", () => {
    expect(openableLinkUrl("https://user:pw@good.com")).toBeNull();
    expect(openableLinkUrl("https://good.example@evil.example/")).toBeNull();
    expect(openableLinkUrl("www.good.com@evil.com")).toBe("mailto:www.good.com@evil.com");
  });

  it("reads a www-looking address as mail, not as a web link", () => {
    expect(openableLinkUrl("www.alice@example.com")).toBe("mailto:www.alice@example.com");
    expect(openableLinkUrl("alice@mail.example.co.uk")).toBe("mailto:alice@mail.example.co.uk");
    expect(openableLinkUrl("alice@nodot")).toBeNull();
  });

  it("answers at once for pathological input, and refuses anything too long", () => {
    for (const evil of ["a@" + "a.".repeat(20000) + "@", "a@" + "a.".repeat(40000) + "@", "x".repeat(MAX_LINK_LENGTH + 1)]) {
      const started = performance.now();
      expect(openableLinkUrl(evil)).toBeNull();
      expect(loadableImageUrl(evil)).toBeNull();
      expect(performance.now() - started).toBeLessThan(50);
    }
    // Under the cap, the pattern itself stays linear.
    const near = "a@" + "a.".repeat(1000) + "@";
    const started = performance.now();
    expect(openableLinkUrl(near)).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
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

  it("opens the link around an image, as a badge does", () => {
    const badge = "see [![build](https://i.example/a.png)](https://v.example/ci) here";
    expect(at(badge, "build")).toEqual({ kind: "url", url: "https://v.example/ci" });
    expect(at(badge, "i.example")).toEqual({ kind: "url", url: "https://v.example/ci" });
    expect(at(badge, "v.example")).toEqual({ kind: "url", url: "https://v.example/ci" });
  });
});
