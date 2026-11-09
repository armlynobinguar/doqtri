import { EditorView } from "@codemirror/view";

/**
 * The editor's look, from the app's theme tokens (app/globals.css), so it
 * follows the light and dark themes and the text-size setting with them.
 *
 * Sizes come in through variables set on `.doqtri-editor` in globals.css —
 * that is where the phone breakpoint and the Profile → Text size setting
 * change them. Every line shares one pixel line height, except headings,
 * which are sized whether their line shows source or not, so the caret
 * moving never changes how tall a line is.
 *
 * Contrast (dark theme, on the page background): body text and headings
 * use --foreground, links --info, muted text --muted-foreground, and the
 * faintest marks — revealed syntax, table borders, the rule, the
 * placeholder — --label, which is ~5:1, above the 4.5:1 floor.
 */

const MONO = "var(--font-code), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--foreground)",
    backgroundColor: "transparent",
    fontSize: "var(--lp-font-size)",
  },
  "&.cm-focused": {
    outline: "none",
    // A quiet edge so keyboard focus is visible without framing the page.
    boxShadow: "inset 2px 0 0 0 color-mix(in oklch, var(--ring) 60%, transparent)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
    lineHeight: "var(--lp-line-height)",
    overscrollBehavior: "contain",
  },
  ".cm-content": {
    maxWidth: "46rem",
    width: "100%",
    margin: "0 auto",
    padding: "var(--lp-pad-top, 20px) var(--lp-pad-x) var(--lp-pad-bottom, 40vh)",
    caretColor: "var(--foreground)",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "1.5px solid var(--foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "color-mix(in oklch, var(--brand-pearl), transparent 72%)" },
  ".cm-placeholder": { color: "var(--label)" },

  // Headings: a clear size step per level, tight tracking like the app's titles.
  ".cm-lp-h1, .cm-lp-h2, .cm-lp-h3, .cm-lp-h4, .cm-lp-h5, .cm-lp-h6": {
    fontWeight: "650",
    letterSpacing: "-0.015em",
  },
  ".cm-lp-h1": { fontSize: "1.75em", lineHeight: "1.3", fontWeight: "700", paddingTop: "0.5em" },
  ".cm-lp-h2": { fontSize: "1.4em", lineHeight: "1.35", paddingTop: "0.45em" },
  ".cm-lp-h3": { fontSize: "1.18em", lineHeight: "1.4", paddingTop: "0.35em" },
  ".cm-lp-h4": { fontSize: "1.05em", lineHeight: "1.45", paddingTop: "0.25em" },
  ".cm-lp-h5": { fontSize: "1em", lineHeight: "1.5" },
  ".cm-lp-h6": { fontSize: "0.95em", lineHeight: "1.5", color: "var(--muted-foreground)" },

  ".cm-lp-syntax": { color: "var(--label)" },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through", color: "var(--muted-foreground)" },
  ".cm-lp-code": {
    fontFamily: MONO,
    fontSize: "0.88em",
    backgroundColor: "var(--glass-strong)",
    borderRadius: "5px",
    padding: "0.1em 0.3em",
  },
  ".cm-lp-link": {
    color: "var(--info)",
    textDecoration: "underline",
    textDecorationColor: "color-mix(in oklch, var(--info) 50%, transparent)",
    textUnderlineOffset: "3px",
  },
  // Wikilinks: the same colour, a dotted underline, so the two read apart.
  ".cm-lp-wikilink": {
    color: "var(--info)",
    textDecoration: "underline dotted",
    textDecorationColor: "color-mix(in oklch, var(--info) 60%, transparent)",
    textUnderlineOffset: "3px",
  },
  // Followable: while ⌘/Ctrl is held, and always where nothing can be edited.
  "&.cm-follow-links .cm-lp-link, &.cm-follow-links .cm-lp-wikilink, .cm-content[contenteditable=false] .cm-lp-link, .cm-content[contenteditable=false] .cm-lp-wikilink":
    { cursor: "pointer", textDecorationStyle: "solid", textDecorationColor: "currentColor" },
  ".cm-lp-image-src": { color: "var(--muted-foreground)" },
  ".cm-lp-list-number": { color: "var(--muted-foreground)" },
  ".cm-lp-bullet": { color: "var(--muted-foreground)", fontWeight: "700" },
  ".cm-lp-task": {
    width: "0.95em",
    height: "0.95em",
    margin: "0 0.2em 0 0",
    verticalAlign: "-0.12em",
    accentColor: "var(--primary)",
    cursor: "pointer",
  },
  ".cm-content[aria-readonly=true] .cm-lp-task": { cursor: "default", opacity: "0.7" },
  ".cm-lp-quote": {
    borderLeft: "2px solid var(--label)",
    paddingLeft: "12px",
    color: "var(--muted-foreground)",
  },
  ".cm-lp-hr": {
    display: "inline-block",
    width: "100%",
    height: "1px",
    verticalAlign: "middle",
    backgroundColor: "var(--label)",
  },

  // Code blocks: one card across their lines, borders on the outer edges.
  ".cm-lp-fence, .cm-lp-codeblock": {
    fontFamily: MONO,
    fontSize: "0.88em",
    backgroundColor: "var(--card)",
    paddingLeft: "14px",
    paddingRight: "14px",
    borderLeft: "1px solid var(--border)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lp-fence-first": { borderTop: "1px solid var(--border)", borderTopLeftRadius: "10px", borderTopRightRadius: "10px" },
  ".cm-lp-fence-last": {
    borderBottom: "1px solid var(--border)",
    borderBottomLeftRadius: "10px",
    borderBottomRightRadius: "10px",
  },
  ".cm-lp-fence-label": { color: "var(--label)", fontFamily: "var(--font-sans), sans-serif", fontSize: "0.85em" },

  // Tables: source in the code face so the pipes line up; rendered as a grid
  // that scrolls sideways inside itself when it is wider than the column.
  ".cm-lp-table-src": { fontFamily: MONO, fontSize: "0.88em" },
  ".cm-lp-table-wrap": {
    maxWidth: "100%",
    overflowX: "auto",
    overscrollBehaviorX: "contain",
    padding: "4px 0 6px",
    cursor: "text",
  },
  ".cm-lp-table": { borderCollapse: "collapse", fontSize: "0.95em", lineHeight: "1.5" },
  ".cm-lp-table th, .cm-lp-table td": {
    border: "1px solid var(--label)",
    padding: "6px 12px",
    minWidth: "5ch",
    verticalAlign: "top",
    // The editor wraps its lines anywhere; a cell must not, or a wide table
    // squeezes into the column a letter wide instead of scrolling.
    overflowWrap: "normal",
    wordBreak: "normal",
  },
  ".cm-lp-table th": { fontWeight: "600", textAlign: "left", backgroundColor: "var(--glass)" },

  // Images: a fixed frame, held while loading and after, so nothing below moves.
  ".cm-lp-image": {
    display: "inline-flex",
    alignItems: "center",
    width: "100%",
    height: "240px",
    verticalAlign: "top",
    margin: "4px 0",
    borderRadius: "10px",
    overflow: "hidden",
  },
  ".cm-lp-image[data-state=loading]": { backgroundColor: "var(--glass)" },
  ".cm-lp-image img": {
    display: "block",
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
    borderRadius: "10px",
  },
  ".cm-lp-image[data-state=broken]": { height: "auto", overflow: "visible" },
  ".cm-lp-image-broken": {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "2px 10px",
    border: "1px dashed var(--label)",
    borderRadius: "8px",
    color: "var(--muted-foreground)",
  },
  ".cm-lp-image-hint": { color: "var(--label)", fontSize: "0.85em" },

  // The line under the title heading (heading-notice.ts, DOQ-36). One fixed
  // line height and size, whatever the text size, so the text below moves
  // once when it appears and never as it changes. The warning tint marks
  // only the icon and the edge: --warning text is under 4.5:1 on the light
  // page, so the words use --foreground and --label.
  ".cm-heading-notice": {
    display: "flex",
    alignItems: "flex-start",
    gap: "6px",
    margin: "0 0 6px",
    padding: "1px 0 1px 8px",
    borderLeft: "2px solid var(--label)",
    fontSize: "12px",
    lineHeight: "18px",
    color: "var(--foreground)",
    cursor: "default",
    userSelect: "none",
  },
  ".cm-heading-notice[data-kind='clash']": { borderLeftColor: "var(--warning)" },
  ".cm-heading-notice-icon": {
    display: "flex",
    flexShrink: "0",
    height: "18px",
    alignItems: "center",
    color: "var(--label)",
  },
  ".cm-heading-notice[data-kind='clash'] .cm-heading-notice-icon": { color: "var(--warning)" },
  ".cm-heading-notice-text": { minWidth: "0" },
  ".cm-heading-notice-hint": { color: "var(--label)" },
  ".cm-heading-notice-dismiss": {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    width: "18px",
    height: "18px",
    marginLeft: "2px",
    padding: "0",
    border: "none",
    borderRadius: "4px",
    background: "transparent",
    color: "var(--label)",
    cursor: "pointer",
    position: "relative",
  },
  // A finger-sized target around the small mark, without a taller line.
  ".cm-heading-notice-dismiss::before": { content: "''", position: "absolute", inset: "-13px" },
  ".cm-heading-notice-dismiss:hover": { color: "var(--foreground)", background: "var(--glass-strong)" },
  ".cm-heading-notice-dismiss:focus-visible": { outline: "1px solid var(--ring)", outlineOffset: "1px" },

  // The `[[` list: the vault's floating glass panel.
  ".cm-tooltip.cm-wikilink-suggest": {
    width: "300px",
    maxWidth: "calc(100vw - 16px)",
    padding: "4px",
    borderRadius: "12px",
    border: "1px solid var(--glass-lo)",
    backgroundColor: "color-mix(in srgb, var(--brand-elevated) 88%, transparent)",
    boxShadow: "inset 0 1px 0 0 var(--glass-hi), var(--shadow-float)",
    backdropFilter: "blur(20px)",
    color: "var(--popover-foreground)",
    fontFamily: "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
  },
  ".cm-tooltip.cm-wikilink-suggest > ul": {
    maxHeight: "216px",
    fontFamily: "inherit",
  },
  ".cm-tooltip.cm-wikilink-suggest > ul > li": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 8px",
    borderRadius: "8px",
    fontSize: "14px",
    lineHeight: "20px",
    color: "var(--muted-foreground)",
    cursor: "default",
  },
  ".cm-tooltip.cm-wikilink-suggest > ul > li[aria-selected]": {
    backgroundColor: "var(--glass-strong)",
    color: "var(--foreground)",
  },
  ".cm-wikilink-icon": { display: "flex", flexShrink: "0", opacity: "0.6" },
  ".cm-tooltip.cm-wikilink-suggest .cm-completionLabel": {
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-tooltip.cm-wikilink-suggest .cm-completionMatchedText": {
    textDecoration: "none",
    fontWeight: "600",
    color: "var(--foreground)",
  },
});
