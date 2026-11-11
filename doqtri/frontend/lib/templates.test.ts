import { describe, expect, it } from "vitest";
import { buildMindmap } from "./mindmap";
import { TEMPLATE_CATEGORIES, TEMPLATES, templateMarkdown } from "./templates";

function countNodes(node: { children: { children: unknown[] }[] }): number {
  return node.children.reduce((sum, child) => sum + 1 + countNodes(child as never), 0);
}

describe("templates", () => {
  it("offers at least ten templates with unique ids", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });

  it.each(TEMPLATES.map((t) => [t.id, t] as const))("%s is a valid starting note", (_, template) => {
    expect(TEMPLATE_CATEGORIES).toContain(template.category);
    // The API writes the `# Title` line; a body must not bring its own.
    expect(template.body).not.toMatch(/^# /m);
    const map = buildMindmap(template.title, templateMarkdown(template));
    expect(map.children).toHaveLength(1);
    expect(countNodes(map)).toBeGreaterThanOrEqual(6);
  });

  it("links every linked note from its main note, and each linked note is a valid note", () => {
    const withLinked = TEMPLATES.filter((t) => t.linkedNotes?.length);
    expect(withLinked.map((t) => t.id)).toContain("freelancer-payments");
    for (const template of withLinked) {
      const titles = template.linkedNotes!.map((n) => n.title);
      expect(new Set([template.title, ...titles]).size).toBe(titles.length + 1);
      for (const note of template.linkedNotes!) {
        expect(template.body).toContain(`[[${note.title}]]`);
        expect(note.body).toContain(`[[${template.title}]]`);
        expect(note.body).not.toMatch(/^# /m);
        const map = buildMindmap(note.title, `# ${note.title}\n\n${note.body}`);
        expect(map.children).toHaveLength(1);
        expect(countNodes(map)).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it("gives the freelancer template five main nodes and five linked notes", () => {
    const t = TEMPLATES.find((x) => x.id === "freelancer-payments")!;
    expect(t.linkedNotes).toHaveLength(5);
    expect(t.body.match(/^## /gm)).toHaveLength(5);
  });
});
