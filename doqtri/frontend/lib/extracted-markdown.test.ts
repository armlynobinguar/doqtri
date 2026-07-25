import { describe, expect, it } from "vitest";
import { cleanExtractedMarkdown } from "@/lib/extracted-markdown";

describe("cleanExtractedMarkdown", () => {
  it("strips an empty frontmatter block", () => {
    expect(cleanExtractedMarkdown("---\n---\n# Title\n")).toBe("# Title");
  });

  it("keeps frontmatter that actually has keys", () => {
    const input = "---\ntitle: Real\n---\n# Title";
    expect(cleanExtractedMarkdown(input)).toBe(input);
  });

  it("strips heading anchors", () => {
    expect(cleanExtractedMarkdown("# Quarterly Review {#quarterly-review}")).toBe(
      "# Quarterly Review",
    );
  });

  it("strips anchors at every heading level", () => {
    const input = "# A {#a}\n## B {#b}\n### C {#c}";
    expect(cleanExtractedMarkdown(input)).toBe("# A\n## B\n### C");
  });

  it("leaves body text containing braces alone", () => {
    const input = "some prose with {#notaheading} inside";
    expect(cleanExtractedMarkdown(input)).toBe(input);
  });

  it("preserves wikilinks in headings", () => {
    expect(cleanExtractedMarkdown("## [[Auth]] flow {#auth-flow}")).toBe(
      "## [[Auth]] flow",
    );
  });

  it("handles the real extractor output shape", () => {
    const extracted = [
      "---",
      "---",
      "",
      "# Quarterly Platform Review {#quarterly-platform-review}",
      "",
      "This review covers the pipeline.",
      "",
      "## Ingestion {#ingestion}",
      "",
      "Documents are converted on upload.",
      "",
    ].join("\n");

    expect(cleanExtractedMarkdown(extracted)).toBe(
      [
        "# Quarterly Platform Review",
        "",
        "This review covers the pipeline.",
        "",
        "## Ingestion",
        "",
        "Documents are converted on upload.",
      ].join("\n"),
    );
  });

  it("is a no-op on already-clean markdown", () => {
    const input = "# Title\n\ntext";
    expect(cleanExtractedMarkdown(input)).toBe(input);
  });
});
