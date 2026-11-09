import { Facet, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { linkAt, openableLinkUrl, type LinkTarget } from "@/lib/live-preview/links";

/**
 * Following links from the editor.
 *
 * A plain click edits: it puts the caret in the link and shows its source.
 * ⌘-click (Ctrl-click off the Mac) follows it, and so does Mod-Enter with the
 * caret inside one. Where the note cannot be edited at all — a viewer, the
 * demo vault — there is nothing to edit, so a plain click follows. Wikilinks
 * open the note they name; web and mail links open in a new tab, with no
 * opener and no referrer; anything else does nothing (lib/live-preview/links).
 */

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The modifier that follows a link, as the hint names it. */
export const FOLLOW_HINT = MAC ? "⌘-click to open" : "Ctrl-click to open";

const followsWith = (event: MouseEvent | KeyboardEvent) => (MAC ? event.metaKey : event.ctrlKey);

/** Opens the note a wikilink names; supplied by whoever hosts the editor. */
export const noteOpener = Facet.define<(title: string) => void, ((title: string) => void) | null>({
  combine: (values) => values[0] ?? null,
});

/** Follows `target`, if it may be followed. */
export function follow(view: EditorView, target: LinkTarget | null): boolean {
  if (!target) return false;
  if (target.kind === "wiki") {
    const open = view.state.facet(noteOpener);
    if (!open) return false;
    open(target.title);
    return true;
  }
  window.open(target.url, "_blank", "noopener,noreferrer");
  return true;
}

/** For rendered table cells, which carry their link on data attributes. */
export function followCellLink(view: EditorView, element: HTMLElement): boolean {
  const title = element.dataset.wikiTitle;
  if (title) return follow(view, { kind: "wiki", title });
  const url = element.dataset.href ? openableLinkUrl(element.dataset.href) : null;
  return follow(view, url ? { kind: "url", url } : null);
}

/** Whether a click follows links rather than edit: a held modifier, or a note nobody can edit. */
export function clickFollows(view: EditorView, event: MouseEvent): boolean {
  return followsWith(event) || !view.state.facet(EditorView.editable);
}

const LINK_SELECTOR = ".cm-lp-link, .cm-lp-wikilink";

/** Marks the editor while the follow modifier is held, for the pointer and underline. */
const modifierTracking = ViewPlugin.fromClass(
  class {
    held = false;
    constructor(readonly view: EditorView) {
      window.addEventListener("keydown", this.onKey);
      window.addEventListener("keyup", this.onKey);
      window.addEventListener("blur", this.release);
    }
    set(held: boolean) {
      if (held === this.held) return;
      this.held = held;
      this.view.dom.classList.toggle("cm-follow-links", held);
    }
    onKey = (event: KeyboardEvent) => this.set(followsWith(event));
    release = () => this.set(false);
    destroy() {
      window.removeEventListener("keydown", this.onKey);
      window.removeEventListener("keyup", this.onKey);
      window.removeEventListener("blur", this.release);
    }
  },
  {
    eventHandlers: {
      // A modifier pressed outside the window shows up on the next move.
      mousemove(event) {
        this.set(followsWith(event));
      },
    },
  },
);

export function linkFollowing(): Extension {
  return [
    modifierTracking,
    // Ahead of CodeMirror's own mouse selection, which would move the caret.
    Prec.high(
      EditorView.domEventHandlers({
        mousedown(event, view) {
          if (event.button !== 0 || !clickFollows(view, event)) return false;
          const element = (event.target as HTMLElement | null)?.closest<HTMLElement>(LINK_SELECTOR);
          if (!element || !view.contentDOM.contains(element)) return false;
          event.preventDefault();
          // On a link that must not open (javascript:, a relative path), a
          // follow-click does nothing at all — not even move the caret.
          follow(view, linkAt(syntaxTree(view.state), view.state.doc, view.posAtDOM(element, 0)));
          return true;
        },
      }),
    ),
    Prec.high(
      keymap.of([
        {
          key: "Mod-Enter",
          run: (view) => {
            const { main } = view.state.selection;
            if (!main.empty) return false;
            return follow(view, linkAt(syntaxTree(view.state), view.state.doc, main.head));
          },
        },
      ]),
    ),
  ];
}
