import { GFM, parser, type MarkdownConfig } from "@lezer/markdown";

/**
 * The markdown dialect the note editor parses: CommonMark, GitHub's extensions
 * (tables, task lists, strikethrough, bare URLs) and Obsidian-style
 * `[[wikilinks]]`.
 *
 * Kept free of CodeMirror so the live-preview rules in this folder can be
 * tested against the very same parse tree the editor builds, without a DOM.
 * The editor passes `PREVIEW_MARKDOWN_EXTENSIONS` to `markdown()`, and the
 * tests parse with `previewParser`; both are CommonMark plus these.
 */

const OPEN_BRACKET = 91; // [
const CLOSE_BRACKET = 93; // ]
const PIPE = 124; // |
const NEWLINE = 10;

/**
 * `[[Target]]` and `[[Target|alias]]` as one `WikiLink` node, its two bracket
 * pairs as `WikiLinkMark`s. Matches what lib/wikilinks.ts treats as a link:
 * no brackets or newline inside, and a non-empty target.
 */
export const WikiLink: MarkdownConfig = {
  defineNodes: [
    { name: "WikiLink" },
    { name: "WikiLinkMark" },
    { name: "WikiLinkTarget" },
  ],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== OPEN_BRACKET || cx.char(pos + 1) !== OPEN_BRACKET) return -1;
        // `[[[` is not a link opener, as findLinkQuery reads it.
        if (cx.char(pos + 2) === OPEN_BRACKET) return -1;
        let pipe = -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === NEWLINE || ch === OPEN_BRACKET) return -1;
          if (ch === PIPE && pipe < 0) pipe = i;
          if (ch === CLOSE_BRACKET) {
            if (cx.char(i + 1) !== CLOSE_BRACKET) return -1;
            const targetEnd = pipe < 0 ? i : pipe;
            if (cx.slice(pos + 2, targetEnd).trim().length === 0) return -1;
            return cx.addElement(
              cx.elt("WikiLink", pos, i + 2, [
                cx.elt("WikiLinkMark", pos, pos + 2),
                cx.elt("WikiLinkTarget", pos + 2, targetEnd),
                cx.elt("WikiLinkMark", i, i + 2),
              ]),
            );
          }
        }
        return -1;
      },
    },
  ],
};

/** What the editor adds to CommonMark; see the module comment. */
export const PREVIEW_MARKDOWN_EXTENSIONS = [GFM, WikiLink];

/** The editor's parser, outside the editor: for tests and for table cells. */
export const previewParser = parser.configure(PREVIEW_MARKDOWN_EXTENSIONS);
