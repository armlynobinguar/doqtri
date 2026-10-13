import { describe, expect, it } from "vitest";
import { buildMindmap } from "./mindmap";
import { DEMO_NOTES, demoNote } from "./demo-vault";

function countNodes(node: { children: { children: unknown[] }[] }): number {
  return node.children.reduce((sum, child) => sum + 1 + countNodes(child as never), 0);
}

describe("demo vault", () => {
  it("opens on the welcome note and has unique, URL-safe ids", () => {
    expect(DEMO_NOTES[0].id).toBe("welcome");
    expect(new Set(DEMO_NOTES.map((n) => n.id)).size).toBe(DEMO_NOTES.length);
    for (const note of DEMO_NOTES) expect(note.id).toMatch(/^[a-z0-9-]+$/);
  });

  it.each(DEMO_NOTES.map((n) => [n.id, n] as const))("%s has a title line and a real mindmap", (_, note) => {
    expect(note.markdown.startsWith(`# ${note.title}\n`)).toBe(true);
    expect(note.description.length).toBeGreaterThan(0);
    const map = buildMindmap(note.title, note.markdown);
    expect(countNodes(map)).toBeGreaterThanOrEqual(6);
  });

  it("looks notes up by id", () => {
    expect(demoNote("product-roadmap")?.title).toBe("Product Roadmap");
    expect(demoNote("not-a-note")).toBeUndefined();
  });
});
