import { EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { completeLink, findLinkQuery, matchIndices, rankLinkSuggestions, type LinkQuery } from "@/lib/wikilinks";

/**
 * Obsidian-style `[[` autocomplete as a CodeMirror completion source. Typing
 * `[[` lists the vault's notes, narrowed as you type; ↑↓ move, Enter or Tab
 * completes the link, Esc dismisses it until the caret leaves that link.
 *
 * Ranking and the completion edit are lib/wikilinks.ts's, exactly as the
 * textarea version used them; CodeMirror only supplies the caret geometry
 * and the list.
 */

const MAX_SUGGESTIONS = 50;

/** The `start` of a link whose list was dismissed with Esc (or just completed). */
const dismiss = StateEffect.define<number | null>();

/** The link at the main caret, in document positions. */
function linkAt(state: EditorState): LinkQuery | null {
  const { main } = state.selection;
  if (!main.empty) return null;
  const line = state.doc.lineAt(main.head);
  const link = findLinkQuery(line.text, main.head - line.from);
  return link ? { start: link.start + line.from, query: link.query } : null;
}

const dismissed = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(dismiss)) return effect.value;
    if (value === null) return null;
    const mapped = tr.changes.mapPos(value);
    // Stays dismissed only while the caret is still inside that same link.
    return linkAt(tr.state)?.start === mapped ? mapped : null;
  },
});

/** Completes the link being typed with `title`, as lib/wikilinks.ts says to. */
function completeWith(view: EditorView, link: LinkQuery, title: string, picked?: Completion) {
  if (view.state.readOnly) return;
  const caret = view.state.selection.main.head;
  const line = view.state.doc.lineAt(caret);
  const edit = completeLink(line.text, caret - line.from, { start: link.start - line.from, query: link.query }, title);
  view.dispatch({
    changes: { from: edit.from + line.from, to: edit.to + line.from, insert: edit.insert },
    selection: { anchor: edit.caret + line.from },
    // Landing inside an aliased link would reopen the list on the title just
    // chosen: treat completing as dismissing it.
    effects: dismiss.of(link.start),
    annotations: picked ? pickedCompletion.of(picked) : undefined,
    userEvent: "input.complete",
  });
}

/** Contiguous runs of matched characters, as [from, to, from, to, …]. */
function matchRanges(label: string, query: string): number[] {
  const ranges: number[] = [];
  for (const i of matchIndices(label, query)) {
    if (ranges.length > 0 && ranges[ranges.length - 1] === i) ranges[ranges.length - 1] = i + 1;
    else ranges.push(i, i + 1);
  }
  return ranges;
}

function wikilinkSource(getTitles: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const link = linkAt(context.state);
    if (!link || context.state.field(dismissed) === link.start) return null;
    const titles = rankLinkSuggestions(getTitles(), link.query, MAX_SUGGESTIONS);
    if (titles.length === 0) return null;
    return {
      from: link.start,
      // Ranked already: CodeMirror must neither filter nor re-sort.
      filter: false,
      options: titles.map(
        (title, i): Completion => ({
          label: title,
          // The list sorts by boost, then alphabetically; boost keeps our order.
          boost: titles.length - i,
          type: "note",
          apply: (view, completion) => completeWith(view, link, title, completion),
        }),
      ),
      getMatch: (completion) => matchRanges(completion.label, link.query),
    };
  };
}

/**
 * Enter and Tab complete the highlighted note. A key pressed while the list is
 * still catching up with the last keystroke (fast typing, then Enter) acts on
 * the text as it is now — the best match for it — rather than falling through
 * to a newline, as the textarea version did.
 */
function acceptLink(getTitles: () => string[]) {
  return (view: EditorView): boolean => {
    if (view.state.readOnly) return false;
    const status = completionStatus(view.state);
    if (status === null) return false;
    if (status === "active" && acceptCompletion(view)) return true;
    const link = linkAt(view.state);
    if (!link || view.state.field(dismissed) === link.start) return false;
    const [best] = rankLinkSuggestions(getTitles(), link.query, 1);
    if (!best) return false;
    completeWith(view, link, best);
    closeCompletion(view);
    return true;
  };
}

/** Esc closes the list for this link, until the caret leaves it. */
function dismissList(view: EditorView): boolean {
  if (completionStatus(view.state) === null) return false;
  const link = linkAt(view.state);
  view.dispatch({ effects: dismiss.of(link?.start ?? null) });
  closeCompletion(view);
  return true;
}

/** lucide "file-text", drawn before each title as in the rest of the vault. */
const FILE_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>';

export function wikilinkCompletion(getTitles: () => string[]): Extension {
  return [
    dismissed,
    // The list is announced by this name, as the old suggest list was.
    EditorState.phrases.of({ Completions: "Link to note" }),
    // Before the completion keymap (same precedence, earlier wins) and markdown's keys:
    // Esc must record the dismissal, Enter and Tab must not miss a list catching up.
    Prec.highest(
      keymap.of([
        { key: "Enter", run: acceptLink(getTitles) },
        { key: "Tab", run: acceptLink(getTitles) },
        { key: "Escape", run: dismissList },
      ]),
    ),
    autocompletion({
      override: [wikilinkSource(getTitles)],
      // The source is synchronous; there is nothing to wait for.
      activateOnTypingDelay: 0,
      // Enter right after the list opens still picks from it.
      interactionDelay: 0,
      icons: false,
      closeOnBlur: true,
      maxRenderedOptions: MAX_SUGGESTIONS,
      tooltipClass: () => "cm-wikilink-suggest",
      addToOptions: [
        {
          position: 20,
          render: () => {
            const icon = document.createElement("span");
            icon.className = "cm-wikilink-icon";
            icon.innerHTML = FILE_ICON;
            return icon;
          },
        },
      ],
    }),
  ];
}
