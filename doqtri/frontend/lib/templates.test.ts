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

  it("client-project keeps the bootcamp slide's sections, in order", () => {
    const template = TEMPLATES.find((t) => t.id === "client-project");
    expect(template).toBeDefined();
    if (!template) return;
    const sections = ["Scope", "Milestones", "Team", "Acceptance", "Risks", "Change requests"];
    const h2 = template.body
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3));
    expect(h2).toEqual(sections);

    // Root is the title; its single child is the `# Client Project` heading.
    const map = buildMindmap(template.title, templateMarkdown(template));
    expect(map.children).toHaveLength(1);
    const titleNode = map.children[0];
    expect(titleNode.label).toBe("Client Project");
    expect(titleNode.children.map((n) => n.label)).toEqual(sections);
    const byLabel = (label: string) => titleNode.children.find((n) => n.label === label);
    expect(byLabel("Milestones")?.children.map((n) => n.label)).toEqual([
      "M1: Design sign-off",
      "M2: Beta release",
      "M3: Go-live",
    ]);
    expect(byLabel("Change requests")?.children).toEqual([]);
  });
});
