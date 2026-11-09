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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { tabsListVariants } from "@/components/ui/tabs";
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
  { id: "source", label: "Source", hint: "Source: the raw markdown, everywhere", icon: CodeXmlIcon },
  { id: "live", label: "Live", hint: "Live: rendered, with the source on the line you edit", icon: PencilLineIcon },
  { id: "reading", label: "Reading", hint: "Reading: rendered, links open on a click", icon: BookOpenIcon },
];

/** Room kept free at the bar's end, so rounding never wraps it. */
const SLACK = 4;
/** A group divider: one pixel and its margins. */
const DIVIDER = 9;

const BUTTON =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring flex shrink-0 items-center justify-center rounded-md transition-colors duration-150 motion-reduce:transition-none hover:bg-[var(--glass-strong)] focus-visible:ring-2 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 aria-pressed:bg-[var(--glass-strong)] aria-pressed:text-foreground aria-pressed:shadow-[inset_0_1px_0_0_var(--glass-hi)] aria-expanded:bg-[var(--glass-strong)] aria-expanded:text-foreground";

function Divider() {
  return <span role="separator" aria-orientation="vertical" className="bg-border mx-1 h-4 w-px shrink-0" />;
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
            className={cn(BUTTON, compact ? "size-11" : "size-7 pointer-coarse:size-11")}
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
  const rightRef = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const [fit, setFit] = useState(GROUPS.length);
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
  const shown = compact ? GROUPS.length : fit;
  const visible = GROUPS.slice(0, shown);
  const folded = GROUPS.slice(shown);

  // Fold groups from the right until the rest fits beside the view switch.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || compact) return;
    const measure = () => {
      for (const el of root.querySelectorAll<HTMLElement>("[data-group-id]")) {
        widths.current.set(el.dataset.groupId!, el.offsetWidth);
      }
      const styles = getComputedStyle(root);
      const room =
        root.clientWidth -
        parseFloat(styles.paddingLeft) -
        parseFloat(styles.paddingRight) -
        (rightRef.current?.offsetWidth ?? 0) -
        SLACK;
      const width = (group: Group) => widths.current.get(group.id) ?? 0;
      if (GROUPS.reduce((sum, group) => sum + width(group), 0) <= room) {
        setFit(GROUPS.length);
        return;
      }
      const more = (root.querySelector<HTMLElement>('[data-tool-id="fullscreen"]')?.offsetWidth ?? 28) + DIVIDER;
      let used = 0;
      let count = 0;
      for (const group of GROUPS) {
        if (used + width(group) > room - more) break;
        used += width(group);
        count++;
      }
      setFit(count);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [compact]);

  // Roving tabindex: one stop for the whole bar, at the last control used.
  const enabled = (id: string, reads = false) =>
    !off && (reads || !reading || id.startsWith("view-") || id === "fullscreen");
  const order = [
    ...visible.flatMap((group) =>
      group.tools ? group.tools.map((tool) => [tool.id, tool.reads] as const) : [["style", false] as const],
    ),
    ...(folded.length ? [["more", true] as const] : []),
    ...VIEWS.map((v) => [`view-${v.id}`, true] as const),
    ["fullscreen", true] as const,
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
                  aria-label={`Paragraph style: ${STYLE_LABEL[formats.style]}`}
                  disabled={off || reading}
                  tabIndex={roving.tabIndex("style")}
                  onMouseDown={(event) => event.preventDefault()}
                  className={cn(
                    BUTTON,
                    "justify-between gap-1 px-2 text-[13px] font-medium",
                    compact ? "h-11 w-36" : "h-7 w-[8.5rem] pointer-coarse:h-11",
                  )}
                />
              }
            />
          }
        >
          <span className="truncate">{STYLE_LABEL[formats.style]}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" strokeWidth={1.75} aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="bottom">Paragraph style</TooltipContent>
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

  const renderGroup = (group: Group) => {
    if (!group.tools) return styleMenu;
    return group.tools.map((tool) => {
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
  };

  const moreMenu = folded.length ? (
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
                    className={cn(BUTTON, "size-7 pointer-coarse:size-11")}
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
          {folded.map((group, i) => (
            <DropdownMenuGroup key={group.id}>
              {i > 0 ? <DropdownMenuSeparator /> : null}
              {!group.tools ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={reading}>Paragraph style</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-60">
                    <DropdownMenuRadioGroup
                      value={formats.style}
                      onValueChange={(value) => applyStyle(value as ParagraphStyle)}
                    >
                      {PARAGRAPH_STYLES.map(({ style, label }) => (
                        <DropdownMenuRadioItem key={style} value={style} closeOnClick>
                          <span data-style-preview className={cn("min-w-0 flex-1 truncate", STYLE_PREVIEW[style])}>
                            {label}
                          </span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : (
                group.tools.map((tool) => {
                  const Icon = tool.icon;
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
                  const history = tool.id === "undo" || tool.id === "redo";
                  const itemDisabled =
                    !enabled(tool.id, tool.reads) || (history && !(tool.id === "undo" ? canUndo : canRedo));
                  const content = (
                    <>
                      <Icon className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden />
                      <span className="flex-1">{tool.label}</span>
                      {tool.shortcut ? (
                        <DropdownMenuShortcut className="tracking-normal">
                          {shortcutLabel(tool.shortcut, mac)}
                        </DropdownMenuShortcut>
                      ) : null}
                    </>
                  );
                  return pressed === undefined ? (
                    <DropdownMenuItem key={tool.id} disabled={itemDisabled} onClick={choose}>
                      {content}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuCheckboxItem
                      key={tool.id}
                      checked={pressed}
                      disabled={itemDisabled}
                      onCheckedChange={choose}
                      closeOnClick
                    >
                      {content}
                    </DropdownMenuCheckboxItem>
                  );
                })
              )}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ) : null;

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
        "border-border/60 flex w-full min-w-0 shrink-0 items-center border-b px-2",
        compact
          ? "h-12 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "h-10 overflow-hidden pointer-coarse:h-12",
      )}
    >
      {visible.map((group, i) => (
        <div
          key={group.id}
          data-group-id={group.id}
          role={group.tools ? "group" : undefined}
          aria-label={group.tools ? group.label : undefined}
          className="flex shrink-0 items-center gap-0.5"
        >
          {i > 0 ? <Divider /> : null}
          {renderGroup(group)}
        </div>
      ))}
      {moreMenu}

      <div ref={rightRef} className="ml-auto flex shrink-0 items-center gap-1 pl-2">
        <div
          role="group"
          aria-label="View"
          className={cn(
            tabsListVariants(),
            "gap-0.5",
            compact ? "h-auto p-0" : "h-8 pointer-coarse:h-auto pointer-coarse:p-0",
          )}
        >
          {VIEWS.map(({ id, label, hint, icon: ViewIcon }) => (
            <Tooltip key={id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    data-tool-id={`view-${id}`}
                    aria-label={label}
                    aria-pressed={mode === id}
                    disabled={off}
                    tabIndex={roving.tabIndex(`view-${id}`)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onModeChange(id)}
                    className={cn(
                      "text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex shrink-0 items-center justify-center gap-1 rounded-[9px] border border-transparent text-[12px] font-medium transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-2 focus-visible:outline-hidden disabled:opacity-50",
                      "aria-pressed:text-foreground aria-pressed:border-[var(--glass-lo)] aria-pressed:bg-[var(--glass-strong)] aria-pressed:shadow-[inset_0_1px_0_0_var(--glass-hi)]",
                      compact ? "size-11" : "h-full px-2 pointer-coarse:h-11 pointer-coarse:px-3",
                    )}
                  />
                }
              >
                {compact ? <ViewIcon className="size-[18px]" strokeWidth={1.75} aria-hidden /> : label}
              </TooltipTrigger>
              <TooltipContent side="bottom">{hint}</TooltipContent>
            </Tooltip>
          ))}
        </div>
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
