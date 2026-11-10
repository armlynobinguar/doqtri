import { describe, expect, it, vi } from "vitest";
import type { RenamedNote } from "@/lib/rename-note";
import { settleTitleLine, type TitleLineSettle } from "@/lib/title-line-settle";

const titleOnly: RenamedNote = { title: "Roadmap", previousTitle: "Plan" };
const rewritten: RenamedNote = { ...titleOnly, markdown: "# Roadmap\n", version: 3, previousVersion: 2 };

/**
 * An editor whose line 1 is `line`, held as the title line unless `held` is
 * false, in a copy that can be edited, going by the new title.
 */
function setup(options: {
  line?: string;
  held?: boolean;
  renamed?: RenamedNote;
  lineBefore?: string;
  safety?: ("allowed" | "blocked" | "unreadable")[];
} = {}) {
  const state = {
    line: options.line ?? "# Pla",
    held: options.held ?? true,
    readOnly: false,
    conflict: false,
    title: "Roadmap",
  };
  const answers = [...(options.safety ?? ["allowed"])];
  const editor = {
    held: vi.fn(() => state.held),
    line: vi.fn(() => state.line),
    retitle: vi.fn((title: string, expected: string) => {
      if (!state.held || state.line !== expected) return null;
      state.line = `# ${title}`;
      return `${state.line}\n\n## Scope\n`;
    }),
    release: vi.fn(() => {
      state.held = false;
    }),
  };
  // Runs between the safety read and the checks after it.
  let meanwhile: () => void = () => {};
  const safety = vi.fn(async () => {
    const answer = answers.shift() ?? "allowed";
    meanwhile();
    return answer;
  });
  const params: TitleLineSettle = {
    renamed: options.renamed ?? titleOnly,
    lineBefore: options.lineBefore ?? options.line ?? "# Pla",
    editor,
    readOnly: () => state.readOnly,
    conflict: () => state.conflict,
    title: () => state.title,
    safety,
    wait: vi.fn(async () => {}),
    rewritten: vi.fn(),
  };
  return {
    state,
    editor,
    safety,
    params,
    meanwhile: (run: () => void) => {
      meanwhile = run;
    },
    run: () => settleTitleLine(params),
  };
}

describe("settleTitleLine (DOQ-46)", () => {
  it("rewrites a held line 1 the server left alone, once the title-line safety allows it", async () => {
    // The prod drift: `# No titl` typed, then renamed from the sidebar before that edit settled.
    const t = setup();
    expect(await t.run()).toBe("rewritten");
    expect(t.safety).toHaveBeenCalledOnce();
    expect(t.editor.retitle).toHaveBeenCalledExactlyOnceWith("Roadmap", "# Pla");
    expect(t.params.rewritten).toHaveBeenCalledExactlyOnceWith("# Roadmap\n\n## Scope\n");
    expect(t.editor.release).not.toHaveBeenCalled();
  });

  it("asks no safety when the server wrote that line itself (the copy could not adopt it)", async () => {
    const t = setup({ renamed: rewritten, line: "# Plan" });
    expect(await t.run()).toBe("rewritten");
    expect(t.safety).not.toHaveBeenCalled();
  });

  it("does nothing when line 1 says the new title already, is not held, or no editor is mounted", async () => {
    expect(await setup({ line: "# Roadmap" }).run()).toBe("none");
    const own = setup({ line: "# Introduction", held: false });
    expect(await own.run()).toBe("none");
    expect(own.editor.release).not.toHaveBeenCalled();
    expect(await settleTitleLine({ ...setup().params, editor: null })).toBe("none");
  });

  it("lets line 1 go when the note's headings are linked or anchored", async () => {
    const t = setup({ safety: ["blocked"] });
    expect(await t.run()).toBe("released");
    expect(t.editor.retitle).not.toHaveBeenCalled();
    expect(t.editor.release).toHaveBeenCalledOnce();
  });

  it("asks a safety read that failed once more, and decides nothing when it fails again", async () => {
    const twice = setup({ safety: ["unreadable", "allowed"] });
    expect(await twice.run()).toBe("rewritten");
    expect(twice.params.wait).toHaveBeenCalledOnce();
    expect(twice.safety).toHaveBeenCalledTimes(2);

    const failing = setup({ safety: ["unreadable", "unreadable"] });
    expect(await failing.run()).toBe("left");
    expect(failing.editor.retitle).not.toHaveBeenCalled();
    expect(failing.editor.release).not.toHaveBeenCalled();
  });

  describe("line 1 typed into while the rename was on its way (review finding 4)", () => {
    it("keeps what was typed and lets line 1 go, with no server rewrite", async () => {
      const t = setup({ line: "# Plax", lineBefore: "# Pla" });
      expect(await t.run()).toBe("released");
      expect(t.editor.retitle).not.toHaveBeenCalled();
      expect(t.safety).not.toHaveBeenCalled();
    });

    it("keeps what was typed and lets line 1 go when the server rewrote and the editor kept the typed line", async () => {
      // adoptRename could not carry the rewrite onto a line typed since: `# Plax` under "Roadmap".
      const t = setup({ renamed: rewritten, line: "# Plax", lineBefore: "# Plan" });
      expect(await t.run()).toBe("released");
      expect(t.editor.retitle).not.toHaveBeenCalled();
    });

    it("lets line 1 go when it is typed into during the safety read (review finding 3)", async () => {
      const t = setup();
      t.meanwhile(() => {
        t.state.line = "# Plax";
      });
      expect(await t.run()).toBe("released");
      expect(t.editor.retitle).not.toHaveBeenCalled();
    });
  });

  describe("every other abort lets line 1 go rather than leave it guarded but dead (review finding 3)", () => {
    it("renamed again during the safety read", async () => {
      const t = setup();
      t.meanwhile(() => {
        t.state.title = "Other";
      });
      expect(await t.run()).toBe("released");
    });

    it("turned read-only during the safety read", async () => {
      const t = setup();
      t.meanwhile(() => {
        t.state.readOnly = true;
      });
      expect(await t.run()).toBe("released");
    });

    it("the editor refusing the rewrite", async () => {
      const t = setup();
      t.editor.retitle.mockReturnValueOnce(null);
      expect(await t.run()).toBe("released");
      expect(t.editor.release).toHaveBeenCalledOnce();
    });

    it("a new title that cannot be a title line", async () => {
      const t = setup({ renamed: { title: "Two\nlines", previousTitle: "Plan" } });
      expect(await t.run()).toBe("released");
    });

    it("but not when line 1 came to say the title meanwhile, or the guard let it go already", async () => {
      const says = setup();
      says.meanwhile(() => {
        says.state.line = "# Roadmap";
      });
      expect(await says.run()).toBe("none");
      expect(says.editor.release).not.toHaveBeenCalled();
      const gone = setup();
      gone.meanwhile(() => {
        gone.state.held = false;
      });
      expect(await gone.run()).toBe("none");
      expect(gone.editor.release).not.toHaveBeenCalled();
    });
  });

  describe("a copy whose renamed text is still on its way keeps line 1 as it is", () => {
    it("one with a conflict waiting: its reload brings the stored text", async () => {
      const t = setup();
      t.state.conflict = true;
      expect(await t.run()).toBe("left");
      expect(t.editor.release).not.toHaveBeenCalled();
      expect(t.editor.retitle).not.toHaveBeenCalled();
    });

    it("a read-only one the server rewrote: its next lock poll loads it", async () => {
      const t = setup({ renamed: rewritten, line: "# Plan" });
      t.state.readOnly = true;
      expect(await t.run()).toBe("left");
      expect(t.editor.release).not.toHaveBeenCalled();
    });

    it("but a read-only one the server did not rewrite gets nothing: line 1 is let go", async () => {
      const t = setup();
      t.state.readOnly = true;
      expect(await t.run()).toBe("released");
      expect(t.safety).not.toHaveBeenCalled();
    });
  });
});
