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
});
