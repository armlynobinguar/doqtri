import { describe, expect, it } from "vitest";
import { FOLD_ORDER, LAST_RESORT, fitTools } from "@/components/vault/live-editor/format-toolbar";

/** The bar's sizes at a desktop pointer: 28px tools, 9px dividers. */
const SIZES = { tool: 28, divider: 9, view: 40, style: { wide: 136, mid: 96, narrow: 40 } };
const P0 = ["undo", "redo", "style", "bold", "italic", "link", "bullet", "ordered"];

describe("fitTools", () => {
  it("shows everything with room to spare", () => {
    expect(fitTools(1100, SIZES)).toEqual({ folded: 0, style: "wide", fullscreenButton: true });
  });

  it("folds tools by priority, the everyday ones only as a last resort", () => {
    expect(FOLD_ORDER.filter((id) => P0.includes(id))).toEqual([]);
    expect([...LAST_RESORT].sort()).toEqual(P0.filter((id) => id !== "style").sort());
    expect(FOLD_ORDER.slice(0, 7)).toEqual(["find", "clear", "hr", "codeblock", "table", "image", "wikilink"]);
    expect(FOLD_ORDER.slice(7)).toEqual(["task", "indent", "outdent", "strike", "code", "quote"]);
  });

  it("at a 400px pane keeps just the everyday tools, with a ¶ style menu", () => {
    // The bar's padding (12) and slack (4) come off first.
    expect(fitTools(400 - 16, SIZES)).toEqual({ folded: FOLD_ORDER.length, style: "narrow", fullscreenButton: false });
  });

  it("shrinks the style menu below 600px and moves full screen into the View menu", () => {
    expect(fitTools(550, SIZES)).toMatchObject({ style: "mid", fullscreenButton: false });
    // Narrower than 400px, the everyday tools go too, from the right, before the bar would clip.
    expect(fitTools(320 - 16, SIZES).folded).toBeGreaterThan(FOLD_ORDER.length);
    expect(fitTools(320 - 16, SIZES).folded).toBeLessThan(FOLD_ORDER.length + LAST_RESORT.length);
    expect(fitTools(700, SIZES)).toMatchObject({ style: "wide", fullscreenButton: true });
  });

  it("folds more as the bar narrows, within each style size", () => {
    // Crossing 600 or 480 shrinks the style menu, which gives tools back.
    for (const [top, bottom] of [
      [1100, 600],
      [599, 480],
      [479, 300],
    ]) {
      let last = 0;
      for (let room = top; room >= bottom; room -= 5) {
        const { folded } = fitTools(room, SIZES);
        expect(folded).toBeGreaterThanOrEqual(last);
        last = folded;
      }
    }
  });
});
