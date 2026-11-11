import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNoteTitleField, type TitleFieldKey } from "@/components/vault/note-title-bar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// React DOM reads the window's current event for an update's priority.
(globalThis as { window?: unknown }).window ??= new EventTarget();

/** Enough of a container for a component that renders nothing (see note-overlay.test.ts). */
function stubContainer(): Element {
  const document: Record<string, unknown> = {
    nodeType: 9,
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  };
  document.defaultView = { document, HTMLIFrameElement: class {} };
  return {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Element;
}

type Props = Parameters<typeof useNoteTitleField>[0];
type Field = ReturnType<typeof useNoteTitleField>;

/** Mounts the field's logic with `props`; `field()` is what it last rendered. */
function mountField(initial: Partial<Props> = {}) {
  let field!: Field;
  const onRename = vi.fn<(title: string) => void>();
  const onDone = vi.fn<() => void>();
  let props: Props = { title: "Alpha", readOnly: false, onRename, onDone, ...initial };
  function Field(p: Props) {
    field = useNoteTitleField(p);
    return null;
  }
  const root: Root = createRoot(stubContainer());
  const render = async (next: Partial<Props> = {}) => {
    props = { ...props, ...next };
    await act(async () => root.render(createElement(Field, props)));
  };
  /** Runs one of the field's handlers as an event would, and lets React render. */
  const fire = async (run: (f: Field) => unknown) => {
    let result: unknown;
    await act(async () => {
      result = run(field);
    });
    return result;
  };
  const key = (name: string, extra: Partial<TitleFieldKey> = {}) =>
    fire((f) => f.keyDown({ key: name, isComposing: false, blur: () => f.blur(), ...extra }));
  return { field: () => field, root, render, fire, key, onRename, onDone };
}

let mounted: ReturnType<typeof mountField> | null = null;

afterEach(async () => {
  await act(async () => mounted?.root.unmount());
  mounted = null;
});

async function mount(initial: Partial<Props> = {}) {
  mounted = mountField(initial);
  await mounted.render();
  return mounted;
}

describe("the title bar's field (D-121)", () => {
  it("shows the title, and follows a new one from outside while not edited", async () => {
    const f = await mount();
    expect(f.field().value).toBe("Alpha");
    await f.render({ title: "Beta" });
    expect(f.field().value).toBe("Beta");
    // Focused but untouched: still follows.
    await f.fire((x) => x.focus());
    await f.render({ title: "Gamma" });
    expect(f.field().value).toBe("Gamma");
  });

  it("never overwrites what is being typed with a title from outside", async () => {
    const f = await mount();
    await f.fire((x) => x.focus());
    await f.fire((x) => x.change("Alph typed"));
    await f.render({ title: "Beta" });
    expect(f.field().value).toBe("Alph typed");
  });

  it("drops what was typed when the copy turns read-only", async () => {
    const f = await mount();
    await f.fire((x) => x.focus());
    await f.fire((x) => x.change("Typed"));
    await f.render({ readOnly: true });
    expect(f.field().value).toBe("Alpha");
    await f.fire((x) => x.blur());
    expect(f.onRename).not.toHaveBeenCalled();
  });

  it("renames once on leaving the field, with the title trimmed", async () => {
    const f = await mount();
    await f.fire((x) => x.focus());
    await f.fire((x) => x.change("  Roadmap "));
    await f.fire((x) => x.blur());
    expect(f.onRename).toHaveBeenCalledTimes(1);
    expect(f.onRename).toHaveBeenCalledWith("Roadmap");
    expect(f.field().value).toBe("Roadmap");
  });

  it("puts the title back on Escape, and renames nothing on the blur after", async () => {
    const f = await mount();
    await f.fire((x) => x.focus());
    await f.fire((x) => x.change("Never"));
    expect(await f.key("Escape")).toBe(true);
    expect(f.field().value).toBe("Alpha");
    await f.fire((x) => x.blur());
    expect(f.onRename).not.toHaveBeenCalled();
  });

  it("asks for nothing for a blank field or the same title, and shows the title again", async () => {
    const f = await mount();
    for (const typed of ["   ", " Alpha ", "Alpha"]) {
      await f.fire((x) => x.focus());
      await f.fire((x) => x.change(typed));
      await f.fire((x) => x.blur());
      expect(f.field().value).toBe("Alpha");
    }
    expect(f.onRename).not.toHaveBeenCalled();
  });

  it("shows a refusal under the field and puts the old title back", async () => {
    const f = await mount();
    f.onRename.mockImplementation(() => {
      throw new Error("Another note is already called “Beta”");
    });
    await f.fire((x) => x.focus());
    await f.fire((x) => x.change("Beta"));
    await f.fire((x) => x.blur());
    expect(f.field().error).toBe("Another note is already called “Beta”");
    expect(f.field().value).toBe("Alpha");
    // Typing again clears it.
    await f.fire((x) => x.change("Bet"));
    expect(f.field().error).toBeNull();
  });

  it("renames on Enter, once, and then hands focus on, even when nothing takes it (Reading view)", async () => {
    const f = await mount();
    await f.fire((x) => x.focus());
    await f.fire((x) => x.change("Roadmap"));
    expect(await f.key("Enter")).toBe(true);
    expect(f.onRename).toHaveBeenCalledTimes(1);
    expect(f.onRename).toHaveBeenCalledWith("Roadmap");
    expect(f.onDone).toHaveBeenCalledTimes(1);
    // The field still has focus; leaving it later renames nothing more.
    await f.fire((x) => x.blur());
    expect(f.onRename).toHaveBeenCalledTimes(1);
  });

  it("renames on Enter once when handing focus on blurs the field at once", async () => {
    const f = await mount();
    f.onDone.mockImplementation(() => f.field().blur());
    await f.fire((x) => x.focus());
    await f.fire((x) => x.change("Roadmap"));
    await f.key("Enter");
    expect(f.onRename).toHaveBeenCalledTimes(1);
  });

  it("renames again on the next Enter after more typing", async () => {
    const f = await mount();
    await f.fire((x) => x.focus());
    await f.fire((x) => x.change("Roadmap"));
    await f.key("Enter");
    await f.render({ title: "Roadmap" });
    await f.fire((x) => x.change("Roadmap 2"));
    await f.fire((x) => x.blur());
    expect(f.onRename.mock.calls).toEqual([["Roadmap"], ["Roadmap 2"]]);
  });

  it("leaves keys being composed alone", async () => {
    const f = await mount();
    await f.fire((x) => x.focus());
    await f.fire((x) => x.change("Kana"));
    expect(await f.key("Enter", { isComposing: true })).toBe(false);
    expect(f.onRename).not.toHaveBeenCalled();
    expect(f.onDone).not.toHaveBeenCalled();
  });
});
