import { describe, expect, it } from "vitest";
import { buildMindmap } from "./mindmap";
import { TEMPLATE_CATEGORIES, TEMPLATES } from "./templates";

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
    // The body is the note's whole text: the title is the row's alone (D-121),
    // so the body opens with its sections, never with a `# ` title of its own.
    expect(template.body).not.toMatch(/^# /m);
    const map = buildMindmap(template.title, template.body);
    expect(map.children.length).toBeGreaterThanOrEqual(2);
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

    // Root is the title; the sections ring it.
    const map = buildMindmap(template.title, template.body);
    expect(map.label).toBe("Client Project");
    expect(map.children.map((n) => n.label)).toEqual(sections);
    const byLabel = (label: string) => map.children.find((n) => n.label === label);
    expect(byLabel("Milestones")?.children.map((n) => n.label)).toEqual([
      "M1: Design sign-off",
      "M2: Beta release",
      "M3: Go-live",
    ]);
    expect(byLabel("Change requests")?.children).toEqual([]);
  });
});
