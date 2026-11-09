"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
  type SVGProps,
} from "react";
import type { EditorView } from "@codemirror/view";
import { closeSearchPanel } from "@codemirror/search";
import {
  BoldIcon,
  BookOpenIcon,
  BracketsIcon,
  ChevronDownIcon,
  CodeIcon,
  CodeXmlIcon,
  EllipsisIcon,
  ImageIcon,
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  ItalicIcon,
  LinkIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  Maximize2Icon,
  Minimize2Icon,
  PencilLineIcon,
  PilcrowIcon,
  Redo2Icon,
  RemoveFormattingIcon,
  SeparatorHorizontalIcon,
  SquareCodeIcon,
  StrikethroughIcon,
  Table2Icon,
  TextQuoteIcon,
  TextSearchIcon,
  Undo2Icon,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ariaShortcut, isMacPlatform, shortcutLabel, withShortcut, type Shortcut } from "@/lib/editor-shortcuts";
import { loadableImageUrl } from "@/lib/live-preview/image";
import {
  clearFormatting,
  indentList,
  insertHorizontalRule,
  insertImage,
  insertLink,
  insertTable,
  MAX_TABLE_SIZE,
  outdentList,
  PARAGRAPH_STYLES,
  setParagraphStyle,
  toggleBlockquote,
  toggleBold,
  toggleBulletList,
  toggleCode,
  toggleCodeBlock,
  toggleItalic,
  toggleOrderedList,
  toggleStrikethrough,
  toggleTaskList,
  type FormatState,
  type ParagraphStyle,
} from "@/lib/live-preview/commands";
import {
  insertWikilinkAndSuggest,
  openFind,
  runFormat,
  runRedo,
  runUndo,
  SHORTCUTS,
} from "@/components/vault/live-editor/editor-actions";

/**
 * The note editor's toolbar, laid out like Word's and Google Docs': undo and
 * redo, a paragraph style menu, then text, insert, list and block groups,
 * clear formatting and find — and on the right the view switch and full
 * screen. Only formatting markdown can store is on it.
 *
 * It is one ARIA toolbar: a single tab stop, arrow keys between controls
 * (roving tabindex). Groups that do not fit fold, from the right, into a
 * More menu, so the bar never wraps; on a phone it scrolls sideways
 * instead, with finger-sized targets.
 */

export type EditorMode = "source" | "live" | "reading";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

type ButtonTool = {
  id: string;
  label: string;
  icon: Icon;
  shortcut?: Shortcut;
  run: (view: EditorView) => void;
  /** A toggle: shown pressed when this is true. */
  pressed?: (ctx: { formats: FormatState; searchOpen: boolean }) => boolean;
  /** Works in Reading view too (nothing it does edits). */
  reads?: boolean;
  /** Asks first, in a popover: the image address, or the table's size. */
  popup?: "image" | "table";
};

type Group =
  | { id: string; label: string; tools: ButtonTool[] }
  | { id: "style"; label: string; tools?: undefined };

const format = (command: Parameters<typeof runFormat>[1]) => (view: EditorView) => void runFormat(view, command);

const GROUPS: Group[] = [
  {
    id: "history",
    label: "History",
    tools: [
      { id: "undo", label: "Undo", icon: Undo2Icon, shortcut: SHORTCUTS.undo, run: (view) => void runUndo(view) },
      { id: "redo", label: "Redo", icon: Redo2Icon, shortcut: SHORTCUTS.redo, run: (view) => void runRedo(view) },
    ],
  },
  { id: "style", label: "Paragraph style" },
  {
    id: "text",
    label: "Text",
    tools: [
      { id: "bold", label: "Bold", icon: BoldIcon, shortcut: SHORTCUTS.bold, run: format(toggleBold), pressed: (c) => c.formats.bold },
      {
        id: "italic",
        label: "Italic",
        icon: ItalicIcon,
        shortcut: SHORTCUTS.italic,
        run: format(toggleItalic),
        pressed: (c) => c.formats.italic,
      },
      {
        id: "strike",
        label: "Strikethrough",
        icon: StrikethroughIcon,
        shortcut: SHORTCUTS.strike,
        run: format(toggleStrikethrough),
        pressed: (c) => c.formats.strike,
      },
      { id: "code", label: "Inline code", icon: CodeIcon, run: format(toggleCode), pressed: (c) => c.formats.code },
    ],
  },
  {
    id: "insert",
    label: "Insert",
    tools: [
      { id: "link", label: "Link", icon: LinkIcon, shortcut: SHORTCUTS.link, run: format(insertLink) },
      { id: "wikilink", label: "Wikilink", icon: BracketsIcon, run: (view) => void insertWikilinkAndSuggest(view) },
      { id: "image", label: "Image", icon: ImageIcon, run: () => {}, popup: "image" },
      { id: "table", label: "Table", icon: Table2Icon, run: () => {}, popup: "table" },
    ],
  },
  {
    id: "lists",
    label: "Lists",
    tools: [
      {
        id: "bullet",
        label: "Bulleted list",
        icon: ListIcon,
        shortcut: SHORTCUTS.bullet,
        run: format(toggleBulletList),
        pressed: (c) => c.formats.bullet,
      },
      {
        id: "ordered",
        label: "Numbered list",
        icon: ListOrderedIcon,
        shortcut: SHORTCUTS.ordered,
        run: format(toggleOrderedList),
        pressed: (c) => c.formats.ordered,
      },
      {
        id: "task",
        label: "Checklist",
        icon: ListChecksIcon,
        shortcut: SHORTCUTS.task,
        run: format(toggleTaskList),
        pressed: (c) => c.formats.task,
      },
      { id: "outdent", label: "Decrease indent", icon: IndentDecreaseIcon, shortcut: SHORTCUTS.outdent, run: format(outdentList) },
      { id: "indent", label: "Increase indent", icon: IndentIncreaseIcon, shortcut: SHORTCUTS.indent, run: format(indentList) },
    ],
  },
  {
    id: "blocks",
    label: "Blocks",
    tools: [
      { id: "quote", label: "Blockquote", icon: TextQuoteIcon, run: format(toggleBlockquote), pressed: (c) => c.formats.quote },
      {
        id: "codeblock",
        label: "Code block",
        icon: SquareCodeIcon,
        run: format(toggleCodeBlock),
        pressed: (c) => c.formats.codeBlock,
      },
      { id: "hr", label: "Horizontal line", icon: SeparatorHorizontalIcon, run: format(insertHorizontalRule) },
    ],
  },
  {
    id: "clear",
    label: "Clear",
    tools: [
      {
        id: "clear",
        label: "Clear formatting",
        icon: RemoveFormattingIcon,
        shortcut: SHORTCUTS.clear,
        run: format(clearFormatting),
      },
    ],
  },
  {
    id: "find",
    label: "Find",
    tools: [
      {
        id: "find",
        label: "Find and replace",
        icon: TextSearchIcon,
        shortcut: SHORTCUTS.find,
        reads: true,
        run: (view) => {
          if (!closeSearchPanel(view)) openFind(view);
        },
        pressed: (c) => c.searchOpen,
      },
    ],
  },
];

const STYLE_LABEL = Object.fromEntries(PARAGRAPH_STYLES.map(({ style, label }) => [style, label])) as Record<
  ParagraphStyle,
  string
>;

/** Each style option previewed in its own look, as in Docs. */
const STYLE_PREVIEW: Record<ParagraphStyle, string> = {
  normal: "text-sm",
  h1: "text-xl font-bold tracking-tight",
  h2: "text-lg font-semibold tracking-tight",
  h3: "text-base font-semibold",
  h4: "text-[15px] font-semibold",
  h5: "text-sm font-semibold",
  h6: "text-[13px] font-semibold text-muted-foreground",
  quote: "border-l-2 border-[var(--label)] pl-2 text-sm text-muted-foreground",
  codeblock: "rounded bg-[var(--glass-strong)] px-1.5 font-mono text-[12.5px]",
};

const VIEWS: { id: EditorMode; label: string; hint: string; icon: Icon }[] = [
  { id: "source", label: "Source", hint: "the raw markdown, everywhere", icon: CodeXmlIcon },
  { id: "live", label: "Live", hint: "rendered, with the source on the line you edit", icon: PencilLineIcon },
  { id: "reading", label: "Reading", hint: "rendered, links open on a click", icon: BookOpenIcon },
];

/**
 * The order tools fold into More as the bar narrows, first to last: the
 * ones a student reaches for least go first. Undo, redo, the style menu,
 * bold, italic, both lists and link stay on the bar down to a 400px pane;
 * only a narrower one folds those too (LAST_RESORT), rather than clip the
 * View menu off the end.
 */
export const FOLD_ORDER = [
  "find",
  "clear",
  "hr",
  "codeblock",
  "table",
  "image",
  "wikilink",
  "task",
  "indent",
  "outdent",
  "strike",
  "code",
  "quote",
];

export const LAST_RESORT = ["link", "ordered", "bullet", "italic", "bold", "redo", "undo"];

const ALL_FOLDS = [...FOLD_ORDER, ...LAST_RESORT];

/** The style menu's width by the bar's: its label, a shorter one, then just ¶. */
type StyleSize = "wide" | "mid" | "narrow";
type Layout = { folded: number; style: StyleSize; fullscreenButton: boolean };

/** Below these bar widths the style menu shrinks, and full screen moves into the View menu. */
const MID_BELOW = 600;
const NARROW_BELOW = 480;

/** Room kept free at the bar's end, so rounding never wraps it. */
const SLACK = 4;
/** Between tools in a group (gap-0.5). */
const GAP = 2;

/**
 * How many tools to fold (in FOLD_ORDER, then LAST_RESORT) for the bar to fit `room` pixels,
 * and how wide the style menu is. Pure, from measured sizes, so it never
 * depends on what is folded at the moment.
 */
export function fitTools(
  room: number,
  size: { tool: number; divider: number; view: number; style: Record<StyleSize, number> },
): Layout {
  const style: StyleSize = room < NARROW_BELOW ? "narrow" : room < MID_BELOW ? "mid" : "wide";
  const fullscreenButton = room >= MID_BELOW;
  const right = size.view + (fullscreenButton ? GAP + size.tool : 0) + 4;
  const widthWith = (folded: Set<string>) => {
    let width = right;
    let groups = 0;
    for (const group of GROUPS) {
      const count = group.tools ? group.tools.filter((tool) => !folded.has(tool.id)).length : 1;
      if (count === 0) continue;
      if (groups++ > 0) width += size.divider;
      width += group.tools ? count * size.tool + (count - 1) * GAP : size.style[style];
    }
    if (folded.size > 0) width += size.divider + size.tool;
    return width;
  };
  for (let folded = 0; folded < ALL_FOLDS.length; folded++) {
    if (widthWith(new Set(ALL_FOLDS.slice(0, folded))) <= room) return { folded, style, fullscreenButton };
  }
  return { folded: ALL_FOLDS.length, style, fullscreenButton };
}

const BUTTON =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring flex shrink-0 items-center justify-center rounded-md transition-colors duration-150 motion-reduce:transition-none hover:bg-[var(--glass-strong)] focus-visible:ring-2 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 aria-pressed:bg-[var(--glass-strong)] aria-pressed:text-foreground aria-pressed:shadow-[inset_0_1px_0_0_var(--glass-hi)] aria-expanded:bg-[var(--glass-strong)] aria-expanded:text-foreground";
const TOOL_SIZE = "size-7 pointer-coarse:size-11";
const VIEW_CLASS = "h-7 gap-0.5 px-1.5 pointer-coarse:h-11 pointer-coarse:px-2.5";
const STYLE_CLASS: Record<StyleSize, string> = {
  wide: "h-7 w-[8.5rem] justify-between gap-1 px-2 text-[13px] font-medium pointer-coarse:h-11",
  mid: "h-7 w-24 justify-between gap-1 px-2 text-[13px] font-medium pointer-coarse:h-11",
  narrow: "h-7 gap-0.5 px-1.5 pointer-coarse:h-11 pointer-coarse:px-2.5",
};
const DIVIDER_CLASS = "flex h-4 shrink-0 px-1 before:block before:w-px before:bg-border";

function Divider() {
  return <span role="separator" aria-orientation="vertical" className={DIVIDER_CLASS} />;
}

type Roving = { tabIndex: (id: string) => 0 | -1 };

function ToolButton({
  tool,
  pressed,
  disabled,
  soft,
  compact,
  mac,
  roving,
  onRun,
  buttonRef,
  expanded,
  hint,
}: {
  tool: Pick<ButtonTool, "id" | "label" | "icon" | "shortcut">;
  pressed?: boolean;
  disabled: boolean;
  /** Looks and reads disabled but keeps focus (undo with nothing to undo). */
  soft?: boolean;
  compact: boolean;
  mac: boolean;
  roving: Roving;
  onRun: (button: HTMLButtonElement) => void;
  buttonRef?: Ref<HTMLButtonElement>;
  expanded?: boolean;
  /** The tooltip, when it should say more than the label and shortcut. */
  hint?: string;
}) {
  const Icon = tool.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={buttonRef}
            type="button"
            data-tool-id={tool.id}
            aria-label={tool.label}
            aria-pressed={pressed}
            aria-keyshortcuts={tool.shortcut ? ariaShortcut(tool.shortcut, mac) : undefined}
            aria-disabled={soft || undefined}
            aria-haspopup={expanded === undefined ? undefined : "dialog"}
            aria-expanded={expanded}
            disabled={disabled}
            tabIndex={roving.tabIndex(tool.id)}
            // Keep the caret, and the selection being formatted, in the editor.
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              if (!soft) onRun(event.currentTarget);
            }}
            className={cn(BUTTON, compact ? "size-11" : TOOL_SIZE)}
          />
        }
      >
        <Icon className={compact ? "size-[18px]" : "size-3.5"} strokeWidth={1.75} aria-hidden />
      </TooltipTrigger>
      <TooltipContent side="bottom">{hint ?? withShortcut(tool.label, tool.shortcut, mac)}</TooltipContent>
    </Tooltip>
  );
}

/** Hover to choose a size, as in Word; arrow keys work too. Up to 8 × 8. */
function TablePicker({ onPick }: { onPick: (columns: number, rows: number) => void }) {
  const [size, setSize] = useState({ columns: 1, rows: 1 });
  const grid = useRef<HTMLDivElement>(null);
  const move = (columns: number, rows: number) => {
    const next = {
      columns: Math.max(1, Math.min(MAX_TABLE_SIZE, columns)),
      rows: Math.max(1, Math.min(MAX_TABLE_SIZE, rows)),
    };
    setSize(next);
    grid.current?.querySelector<HTMLElement>(`[data-cell="${next.columns}x${next.rows}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, [number, number]> = {
      ArrowRight: [1, 0],
      ArrowLeft: [-1, 0],
      ArrowDown: [0, 1],
      ArrowUp: [0, -1],
    };
    const delta = step[event.key];
    if (!delta) return;
    event.preventDefault();
    move(size.columns + delta[0], size.rows + delta[1]);
  };
  return (
    <div className="flex flex-col gap-2">
      <PopoverTitle>Insert table</PopoverTitle>
      <div
        ref={grid}
        role="group"
        aria-label="Table size"
        onKeyDown={onKeyDown}
        className="grid w-fit grid-cols-8 gap-1"
      >
        {Array.from({ length: MAX_TABLE_SIZE * MAX_TABLE_SIZE }, (_, i) => {
          const columns = (i % MAX_TABLE_SIZE) + 1;
          const rows = Math.floor(i / MAX_TABLE_SIZE) + 1;
          const on = columns <= size.columns && rows <= size.rows;
          const current = columns === size.columns && rows === size.rows;
          return (
            <button
              key={i}
              type="button"
              data-cell={`${columns}x${rows}`}
              aria-label={`${columns} by ${rows} table`}
              tabIndex={current ? 0 : -1}
              onMouseEnter={() => setSize({ columns, rows })}
              onFocus={() => setSize({ columns, rows })}
              onClick={() => onPick(columns, rows)}
              className={cn(
                "focus-visible:ring-ring size-5 rounded-[4px] border transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:outline-hidden pointer-coarse:size-8",
                on
                  ? "border-[var(--glass-hi)] bg-[color-mix(in_oklch,white_22%,transparent)]"
                  : "border-[var(--glass-lo)] bg-[var(--glass)]",
              )}
            />
          );
        })}
      </div>
      <PopoverDescription aria-live="polite" className="tabular-nums">
        {size.columns} × {size.rows} — {size.columns === 1 ? "1 column" : `${size.columns} columns`},{" "}
        {size.rows === 1 ? "header row only" : `header and ${size.rows - 1} ${size.rows === 2 ? "row" : "rows"}`}
      </PopoverDescription>
    </div>
  );
}

/** The image's web address and alt text; only http(s), as the preview loads. */
function ImagePrompt({ onInsert }: { onInsert: (url: string, alt: string) => void }) {
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!loadableImageUrl(url)) {
      setError("Use a web address that starts with https:// or http://.");
      return;
    }
    onInsert(url.trim(), alt);
  };
  return (
    // Checked here, not by the browser: type=url would accept javascript:.
    <form noValidate onSubmit={submit} className="flex flex-col gap-3">
      <PopoverTitle>Insert image</PopoverTitle>
      <label className="flex flex-col gap-1.5">
        <span className="text-label text-xs">Image address</span>
        <Input
          type="url"
          inputMode="url"
          placeholder="https://"
          autoComplete="off"
          value={url}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "image-url-error" : undefined}
          onChange={(event) => {
            setUrl(event.target.value);
            setError(null);
          }}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-label text-xs">Alt text</span>
        <Input
          placeholder="What the image shows"
          autoComplete="off"
          value={alt}
          onChange={(event) => setAlt(event.target.value)}
        />
      </label>
      {error ? (
        <p id="image-url-error" role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" size="sm">
          Insert image
        </Button>
      </div>
    </form>
  );
}

export function FormatToolbar({
  view,
  formats,
  canUndo,
  canRedo,
  searchOpen,
  compact,
  disabled,
  mode,
  onModeChange,
  fullscreen,
  onFullscreenChange,
}: {
  view: EditorView | null;
  formats: FormatState;
  canUndo: boolean;
  canRedo: boolean;
  searchOpen: boolean;
  /** Phone layout: one row that scrolls sideways, 44px targets. */
  compact: boolean;
  /** While the edit lock loads: shown, but nothing works. */
  disabled: boolean;
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  fullscreen: boolean;
  onFullscreenChange: (fullscreen: boolean) => void;
}) {
  const [mac] = useState(() => isMacPlatform(navigator.platform || navigator.userAgent));
  const rootRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>({ folded: 0, style: "wide", fullscreenButton: true });
  const [active, setActive] = useState("undo");
  const [popup, setPopup] = useState<"image" | "table" | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [moreButton, setMoreButton] = useState<HTMLButtonElement | null>(null);
  /** A popover to open once the More menu has closed and given focus back. */
  const pendingPopup = useRef<"image" | "table" | null>(null);
  /** Whether a closing menu or popover should hand focus back to the text. */
  const toEditor = useRef(false);

  const off = disabled || !view;
  const reading = mode === "reading";
  const ctx = view ? { view } : null;
  const shown: Layout = compact ? { folded: 0, style: "wide", fullscreenButton: true } : layout;
  const folded = new Set(ALL_FOLDS.slice(0, shown.folded));
  const fullscreenButton = shown.fullscreenButton || fullscreen;

  // Fold tools by priority until the rest fits; see FOLD_ORDER.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const measure = measureRef.current;
    if (!root || !measure || compact) return;
    const width = (name: string) => measure.querySelector<HTMLElement>(`[data-measure="${name}"]`)?.offsetWidth ?? 0;
    const update = () => {
      const styles = getComputedStyle(root);
      const room = root.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight) - SLACK;
      const next = fitTools(room, {
        tool: width("tool"),
        divider: width("divider"),
        view: width("view"),
        style: { wide: width("style-wide"), mid: width("style-mid"), narrow: width("style-narrow") },
      });
      setLayout((prev) =>
        prev.folded === next.folded && prev.style === next.style && prev.fullscreenButton === next.fullscreenButton ? prev : next,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, [compact]);

  // The groups as shown: folded tools left out, empty groups dropped.
  const visible = GROUPS.map((group) => ({
    ...group,
    tools: group.tools?.filter((tool) => !folded.has(tool.id)),
  })).filter((group) => !group.tools || group.tools.length > 0);
  const inMore = GROUPS.map((group) => ({ ...group, tools: (group.tools ?? []).filter((tool) => folded.has(tool.id)) })).filter(
    (group) => group.tools.length > 0,
  );

  // Roving tabindex: one stop for the whole bar, at the last control used.
  const enabled = (id: string, reads = false) =>
    !off && (reads || !reading || id === "view" || id === "fullscreen" || id === "more");
  const order = [
    ...visible.flatMap((group) =>
      group.tools ? group.tools.map((tool) => [tool.id, tool.reads] as const) : [["style", false] as const],
    ),
    ...(inMore.length ? [["more", true] as const] : []),
    ["view", true] as const,
    ...(fullscreenButton ? [["fullscreen", true] as const] : []),
  ].filter(([id, reads]) => enabled(id, reads));
  const current = order.some(([id]) => id === active) ? active : (order[0]?.[0] ?? "");
  const roving: Roving = { tabIndex: (id) => (id === current ? 0 : -1) };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-tool-id]")].filter(
      (el) => !el.disabled,
    );
    const from = (event.target as HTMLElement).closest<HTMLElement>("[data-tool-id]");
    const at = from ? items.indexOf(from as HTMLButtonElement) : -1;
    if (at < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (at + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
    setActive(items[next].dataset.toolId!);
  };

  const run = (tool: ButtonTool, button: HTMLElement) => {
    if (!ctx) return;
    if (tool.popup) {
      setAnchor(button);
      setPopup(tool.popup);
      return;
    }
    tool.run(ctx.view);
    // From the keyboard, focus stays on the bar; from a click it goes (or
    // stays) in the editor — unless the tool moved it there, to the find field.
    if (button.matches(":focus-visible") || ctx.view.dom.contains(document.activeElement)) return;
    ctx.view.focus();
  };

  const closePopup = (insert?: (view: EditorView) => void) => {
    if (insert && ctx) {
      insert(ctx.view);
      toEditor.current = true;
    }
    setPopup(null);
  };

  /** Back to the text after a menu choice or an insert; elsewhere after Esc. */
  const finalFocus = () => {
    const back = toEditor.current;
    toEditor.current = false;
    if (back && ctx) {
      requestAnimationFrame(() => ctx.view.focus());
      return false;
    }
    return true;
  };

  const applyStyle = (style: ParagraphStyle) => {
    if (!ctx) return;
    runFormat(ctx.view, setParagraphStyle(style));
    toEditor.current = true;
  };

  const styleLabel = STYLE_LABEL[formats.style];
  const styleMenu = (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              disabled={off || reading}
              render={
                <button
                  type="button"
                  data-tool-id="style"
                  aria-label={`Paragraph style: ${styleLabel}`}
                  disabled={off || reading}
                  tabIndex={roving.tabIndex("style")}
                  onMouseDown={(event) => event.preventDefault()}
                  className={cn(BUTTON, compact ? cn(STYLE_CLASS.wide, "h-11 w-36") : STYLE_CLASS[shown.style])}
                />
              }
            />
          }
        >
          {shown.style === "narrow" && !compact ? (
            <PilcrowIcon className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
          ) : (
            <span className="truncate">{styleLabel}</span>
          )}
          <ChevronDownIcon className="size-3 shrink-0 opacity-70" strokeWidth={1.75} aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="bottom">Paragraph style: {styleLabel}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent className="w-60" finalFocus={finalFocus}>
        <DropdownMenuRadioGroup value={formats.style} onValueChange={(value) => applyStyle(value as ParagraphStyle)}>
          {PARAGRAPH_STYLES.map(({ style, label }) => (
            <DropdownMenuRadioItem key={style} value={style} closeOnClick>
              <span data-style-preview className={cn("min-w-0 flex-1 truncate", STYLE_PREVIEW[style])}>
                {label}
              </span>
              {style in SHORTCUTS ? (
                <DropdownMenuShortcut className="tracking-normal">
                  {shortcutLabel(SHORTCUTS[style as keyof typeof SHORTCUTS], mac)}
                </DropdownMenuShortcut>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const renderTools = (tools: ButtonTool[]) =>
    tools.map((tool) => {
      const history = tool.id === "undo" || tool.id === "redo";
      return (
        <ToolButton
          key={tool.id}
          tool={tool}
          pressed={tool.pressed?.({ formats, searchOpen })}
          disabled={!enabled(tool.id, tool.reads)}
          soft={history && !(tool.id === "undo" ? canUndo : canRedo)}
          compact={compact}
          mac={mac}
          roving={roving}
          expanded={tool.popup ? popup === tool.popup : undefined}
          onRun={(button) => run(tool, button)}
        />
      );
    });

  const moreMenu = inMore.length ? (
    <div className="flex shrink-0 items-center">
      <Divider />
      <DropdownMenu
        onOpenChangeComplete={(open) => {
          if (open || !pendingPopup.current) return;
          setAnchor(moreButton);
          setPopup(pendingPopup.current);
          pendingPopup.current = null;
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                disabled={off}
                render={
                  <button
                    ref={setMoreButton}
                    type="button"
                    data-tool-id="more"
                    aria-label="More formatting"
                    disabled={off}
                    tabIndex={roving.tabIndex("more")}
                    onMouseDown={(event) => event.preventDefault()}
                    className={cn(BUTTON, TOOL_SIZE)}
                  />
                }
              />
            }
          >
            <EllipsisIcon className="size-3.5" strokeWidth={1.75} aria-hidden />
          </TooltipTrigger>
          <TooltipContent side="bottom">More formatting</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-64" finalFocus={finalFocus}>
          {inMore.map((group, i) => (
            <DropdownMenuGroup key={group.id}>
              {i > 0 ? <DropdownMenuSeparator /> : null}
              {group.tools.map((tool) => {
                const ToolIcon = tool.icon;
                const pressed = tool.pressed?.({ formats, searchOpen });
                const choose = () => {
                  if (!ctx) return;
                  if (tool.popup) {
                    pendingPopup.current = tool.popup;
                    return;
                  }
                  tool.run(ctx.view);
                  toEditor.current = tool.id !== "find";
                };
                const content = (
                  <>
                    <ToolIcon className="text-muted-foreground size-4" strokeWidth={1.75} aria-hidden />
                    <span className="flex-1">{tool.label}</span>
                    {tool.shortcut ? (
                      <DropdownMenuShortcut className="tracking-normal">{shortcutLabel(tool.shortcut, mac)}</DropdownMenuShortcut>
                    ) : null}
                  </>
                );
                return pressed === undefined ? (
                  <DropdownMenuItem key={tool.id} disabled={!enabled(tool.id, tool.reads)} onClick={choose}>
                    {content}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuCheckboxItem
                    key={tool.id}
                    checked={pressed}
                    disabled={!enabled(tool.id, tool.reads)}
                    onCheckedChange={choose}
                    closeOnClick
                  >
                    {content}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ) : null;

  const currentView = VIEWS.find((v) => v.id === mode) ?? VIEWS[1];
  const ViewIcon = currentView.icon;
  const viewMenu = (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              disabled={off}
              render={
                <button
                  type="button"
                  data-tool-id="view"
                  aria-label={`View: ${currentView.label}`}
                  disabled={off}
                  tabIndex={roving.tabIndex("view")}
                  onMouseDown={(event) => event.preventDefault()}
                  className={cn(BUTTON, VIEW_CLASS, compact && "h-11 px-3")}
                />
              }
            />
          }
        >
          <ViewIcon className={compact ? "size-[18px]" : "size-3.5"} strokeWidth={1.75} aria-hidden />
          <ChevronDownIcon className="size-3 opacity-70" strokeWidth={1.75} aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="bottom">View: {currentView.hint}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-72" finalFocus={finalFocus}>
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => {
            onModeChange(value as EditorMode);
            toEditor.current = value !== "reading";
          }}
        >
          {VIEWS.map(({ id, label, hint, icon: ItemIcon }) => (
            <DropdownMenuRadioItem key={id} value={id} closeOnClick>
              <ItemIcon className="text-muted-foreground size-4" strokeWidth={1.75} aria-hidden />
              <span className="flex flex-col">
                <span>{label}</span>
                <span className="text-muted-foreground text-xs">{hint}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={fullscreen} onCheckedChange={() => onFullscreenChange(!fullscreen)} closeOnClick>
          <Maximize2Icon className="text-muted-foreground size-4" strokeWidth={1.75} aria-hidden />
          <span className="flex-1">Full screen</span>
          <DropdownMenuShortcut className="tracking-normal">Esc exits</DropdownMenuShortcut>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  let groupIndex = 0;
  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      aria-disabled={off || undefined}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const id = (event.target as HTMLElement).closest<HTMLElement>("[data-tool-id]")?.dataset.toolId;
        if (id) setActive(id);
      }}
      className={cn(
        "border-border/60 relative flex w-full min-w-0 shrink-0 items-center border-b px-1.5",
        compact
          ? "h-12 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "h-10 overflow-hidden pointer-coarse:h-12",
      )}
    >
      {/* The sizes the fold works from, measured off-screen in the bar's own styles. */}
      {compact ? null : (
        <div
          ref={measureRef}
          aria-hidden
          className="pointer-events-none invisible absolute top-0 left-0 flex h-0 w-0 items-center overflow-hidden"
        >
          <span data-measure="tool" className={cn("block shrink-0", TOOL_SIZE)} />
          <span data-measure="divider" className={DIVIDER_CLASS} />
          <span data-measure="view" className={cn(BUTTON, VIEW_CLASS)}>
            <span className="size-3.5" />
            <span className="size-3" />
          </span>
          {(["wide", "mid", "narrow"] as const).map((size) => (
            <span key={size} data-measure={`style-${size}`} className={cn(BUTTON, STYLE_CLASS[size])}>
              <span className="size-3.5" />
              <span className="size-3" />
            </span>
          ))}
        </div>
      )}

      {visible.map((group) => {
        const first = groupIndex++ === 0;
        return (
          <div key={group.id} data-group-id={group.id} className="flex shrink-0 items-center">
            {first ? null : <Divider />}
            <div
              role={group.tools ? "group" : undefined}
              aria-label={group.tools ? group.label : undefined}
              className="flex items-center gap-0.5"
            >
              {group.tools ? renderTools(group.tools) : styleMenu}
            </div>
          </div>
        );
      })}
      {moreMenu}

      <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
        {viewMenu}
        {fullscreenButton ? (
          <ToolButton
            tool={{
              id: "fullscreen",
              label: "Full screen",
              icon: fullscreen ? Minimize2Icon : Maximize2Icon,
              shortcut: undefined,
            }}
            hint={fullscreen ? "Exit full screen (Esc)" : "Full screen (Esc to exit)"}
            pressed={fullscreen}
            disabled={off}
            compact={compact}
            mac={mac}
            roving={roving}
            onRun={() => onFullscreenChange(!fullscreen)}
          />
        ) : null}
      </div>

      <Popover open={popup === "image"} onOpenChange={(open) => !open && closePopup()}>
        <PopoverContent anchor={anchor} align="start" finalFocus={finalFocus}>
          <ImagePrompt onInsert={(url, alt) => closePopup((v) => runFormat(v, insertImage(url, alt)))} />
        </PopoverContent>
      </Popover>
      <Popover open={popup === "table"} onOpenChange={(open) => !open && closePopup()}>
        <PopoverContent anchor={anchor} align="start" className="w-auto" finalFocus={finalFocus}>
          <TablePicker onPick={(columns, rows) => closePopup((v) => runFormat(v, insertTable(columns, rows)))} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
