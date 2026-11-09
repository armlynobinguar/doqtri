import { Facet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { headingNoticeText, type HeadingNotice } from "@/lib/heading-rename";

/**
 * The small line under the note's title heading (DOQ-36): why an edit of the
 * heading did not rename the note (another note has that title), or that it
 * did while other notes still link to the old title.
 *
 * A block widget after the heading line, so it sits with the heading and
 * never covers text. There is only ever one: a new notice updates it in
 * place (updateDOM), and its height is fixed by the theme, so text below it
 * moves once, when it appears, and not as it changes.
 *
 * Shown only while the note's first non-blank line is a `#` heading; the
 * workspace clears it when the heading goes. Screen readers hear it through
 * the editor's polite status region (markdown-editor.tsx), which outlives
 * the widget.
 */

/** Sets the notice, or clears it with null. */
export const setHeadingNotice = StateEffect.define<HeadingNotice | null>();

/** What the notice's Dismiss button calls. */
export const headingNoticeDismiss = Facet.define<() => void, (() => void) | undefined>({
  combine: (values) => values[0],
});

// lucide "triangle-alert", "info" and "x", inline so no React is needed inside the editor.
const SVG_ATTRS =
  'viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const ICONS = {
  clash: `<svg ${SVG_ATTRS}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  renamed: `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
  dismiss: `<svg ${SVG_ATTRS}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
};

class HeadingNoticeWidget extends WidgetType {
  constructor(readonly notice: HeadingNotice) {
    super();
  }

  eq(other: HeadingNoticeWidget) {
    const a = headingNoticeText(this.notice);
    const b = headingNoticeText(other.notice);
    return this.notice.kind === other.notice.kind && a.message === b.message && a.hint === b.hint;
  }

  get estimatedHeight() {
    return 26;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-heading-notice";
    box.dataset.testid = "heading-notice";
    this.fill(box, view);
    return box;
  }

  /** A changed notice reuses the box, so it updates in place rather than being redrawn. */
  updateDOM(dom: HTMLElement, view: EditorView) {
    this.fill(dom, view);
    return true;
  }

  private fill(box: HTMLElement, view: EditorView) {
    const { kind } = this.notice;
    const { message, hint } = headingNoticeText(this.notice);
    box.dataset.kind = kind;

    const icon = document.createElement("span");
    icon.className = "cm-heading-notice-icon";
    icon.innerHTML = ICONS[kind];

    const text = document.createElement("span");
    text.className = "cm-heading-notice-text";
    const main = document.createElement("span");
    main.textContent = message;
    text.append(main);
    if (hint) {
      const extra = document.createElement("span");
      extra.className = "cm-heading-notice-hint";
      extra.textContent = ` ${hint}`;
      text.append(extra);
    }

    const parts: HTMLElement[] = [icon, text];
    if (kind === "renamed") {
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "cm-heading-notice-dismiss";
      dismiss.setAttribute("aria-label", "Dismiss");
      dismiss.title = "Dismiss";
      dismiss.innerHTML = ICONS.dismiss;
      // The caret stays where it was in the text.
      dismiss.addEventListener("mousedown", (event) => event.preventDefault());
      dismiss.addEventListener("click", () => view.state.facet(headingNoticeDismiss)?.());
      parts.push(dismiss);
    }
    box.replaceChildren(...parts);
  }

  ignoreEvent() {
    // Clicks are the Dismiss button's; none of them moves the caret.
    return true;
  }
}

/** The end of the title heading line, where the notice goes, or null when the note has none. */
function headingEnd(state: EditorState): number | null {
  const { doc } = state;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (/^[ \t\f\v]*\r?$/.test(line.text)) continue;
    return /^#([ \t]|$)/.test(line.text) ? line.to : null;
  }
  return null;
}

type NoticeState = { notice: HeadingNotice | null; decorations: DecorationSet };

function build(state: EditorState, notice: HeadingNotice | null): NoticeState {
  const at = notice ? headingEnd(state) : null;
  const decorations =
    notice && at !== null
      ? Decoration.set([Decoration.widget({ widget: new HeadingNoticeWidget(notice), block: true, side: 1 }).range(at)])
      : Decoration.none;
  return { notice, decorations };
}

const noticeField = StateField.define<NoticeState>({
  create: (state) => build(state, null),
  update(value, tr) {
    let notice = value.notice;
    let changed = false;
    for (const effect of tr.effects) {
      if (effect.is(setHeadingNotice)) {
        notice = effect.value;
        changed = true;
      }
    }
    if (!changed && !tr.docChanged) return value;
    if (!notice) return value.notice ? build(tr.state, null) : value;
    return build(tr.state, notice);
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** The notice field, ready to add to an editor's extensions. */
export function headingNotice(): Extension {
  return noticeField;
}
