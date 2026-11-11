import { describe, expect, it, vi } from "vitest";
import { createFromTemplate, relink } from "./template-notes";
import { TEMPLATES } from "./templates";

const freelancer = TEMPLATES.find((t) => t.id === "freelancer-payments")!;

describe("createFromTemplate", () => {
  it("creates the linked notes first, then the main note that links them", async () => {
    const calls: { title: string; body: string; workspaceId?: string }[] = [];
    const create = vi.fn(async (title: string, body: string, workspaceId?: string) => {
      calls.push({ title, body, workspaceId });
      return { id: `id-${calls.length}`, title };
    });

    const main = await createFromTemplate(freelancer, "ws-1", create);

    expect(calls).toHaveLength(6);
    expect(calls.slice(0, 5).map((c) => c.title)).toEqual(freelancer.linkedNotes!.map((n) => n.title));
    expect(calls[5].title).toBe(freelancer.title);
    expect(calls.every((c) => c.workspaceId === "ws-1")).toBe(true);
    for (const note of freelancer.linkedNotes!) expect(calls[5].body).toContain(`[[${note.title}]]`);
    expect(main).toEqual({ id: "id-6", title: freelancer.title, linked: 5 });
  });

  it("follows the titles the server gives de-duplicated copies", async () => {
    const create = vi.fn<(title: string, body: string) => Promise<{ id: string; title: string }>>(async (title) => ({
      id: title,
      title: `${title} 2`,
    }));

    await createFromTemplate(freelancer, undefined, create);

    const mainBody = create.mock.calls[5][1];
    expect(mainBody).toContain("[[Freelancer Payments 1 · The Problem 2]]");
    expect(mainBody).not.toContain("[[Freelancer Payments 1 · The Problem]]");
    // A later linked note points back at an earlier copy's real title.
    expect(create.mock.calls[4][1]).toContain("[[Freelancer Payments 1 · The Problem 2]]");
  });

  it("creates just the main note for a template without linked notes", async () => {
    const plain = TEMPLATES.find((t) => !t.linkedNotes)!;
    const create = vi.fn(async (title: string) => ({ id: "x", title }));

    const main = await createFromTemplate(plain, undefined, create);

    expect(create).toHaveBeenCalledTimes(1);
    expect(main.linked).toBe(0);
  });
});

describe("relink", () => {
  it("only rewrites whole wikilinks", () => {
    const out = relink("See [[A]] and [[AB]], not A.", new Map([["A", "A 2"]]));
    expect(out).toBe("See [[A 2]] and [[AB]], not A.");
  });
});
