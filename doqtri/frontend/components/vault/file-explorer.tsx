"use client";

import { NavLink } from "@/components/vault/navigation";
import {
  LayoutTemplateIcon,
  FileTextIcon,
  ChevronDownIcon,
  LinkIcon,
  Link2OffIcon,
  UploadIcon,
  FilePlusIcon,
  Loader2Icon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { RetryTarget } from "@/components/vault/upload-dialog";
import type { FailedImport, NoteSummary } from "@/lib/types";

/**
 * Flat vault listing under a single root. The schema is one table with no
 * folder column, so there is no hierarchy to render — inventing one would
 * mean a second table, which the spec defers to v2.
 */
export function FileExplorer({
  notes,
  activeId,
  header,
  canCreate = true,
  onNewNote,
  onUploadClick,
  onTemplatesClick,
  creating = false,
  failedImports = [],
  onRetryImport,
  onDismissImport,
  anchoredIds,
  onDeleteNote,
  isPending,
  onRenameNote,
}: {
  notes: NoteSummary[];
  activeId?: string;
  /** Replaces the "Vault" heading: the vault shell puts the workspace switcher here. */
  header?: React.ReactNode;
  /**
   * False for a viewer of the workspace shown (D-14): the create buttons are
   * disabled, and the write actions on rows (rename, delete, retrying an
   * import into this workspace) are not shown. The server refuses them all
   * anyway; this keeps a viewer from being offered them.
   */
  canCreate?: boolean;
  onNewNote: () => void;
  onUploadClick: () => void;
  onTemplatesClick?: () => void;
  creating?: boolean;
  failedImports?: FailedImport[];
  onRetryImport?: (target: RetryTarget) => void;
  onDismissImport?: (id: string) => void;
  /** Notes with a record on the ledger. Those cannot be deleted. */
  anchoredIds?: ReadonlySet<string>;
  onDeleteNote?: (note: NoteSummary) => void;
  /**
   * Whether a rename or delete of this note is still waiting on the server.
   * Its row offers neither until then, so a second one cannot race the first.
   */
  isPending?: (id: string) => boolean;
  onRenameNote?: (note: NoteSummary) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Split by whether the ledger has the note. Until the ledger answers (or if
  // it cannot be reached) `anchoredIds` is undefined and the list stays whole,
  // rather than showing every note as off-chain and then reshuffling.
  const sections: Section[] = anchoredIds
    ? [
        {
          key: "onchain",
          label: "On-chain",
          tone: "onchain",
          notes: notes.filter((note) => anchoredIds.has(note.id)),
          empty: "Nothing anchored yet.",
          hint: "Anchored on Stellar. These notes can be renamed, but their on-chain record cannot be deleted.",
        },
        {
          key: "offchain",
          label: "Off-chain",
          tone: "offchain",
          notes: notes.filter((note) => !anchoredIds.has(note.id)),
          empty: "Every note is anchored.",
          hint: "Saved in your vault only. Anchor a note to put a record of it on Stellar.",
        },
      ]
    : [{ key: "all", label: "Notes", tone: "plain", notes }];

  return (
    <aside className="bg-sidebar flex h-full min-h-0 flex-col">
      <header className="border-border flex h-10 shrink-0 pointer-coarse:h-12 items-center justify-between gap-1 border-b pr-1.5 pl-3">
        <div className="flex min-w-0 items-center">{header ?? <span className="eyebrow">Vault</span>}</div>
        <div className="flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger
              aria-label="New note"
              // TooltipTrigger's own `disabled` only stops the tooltip; the button needs it.
              render={<button type="button" disabled={creating || !canCreate} />}
              onClick={onNewNote}
              className="text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent flex size-7 items-center justify-center rounded-lg transition-colors pointer-coarse:size-10 focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden disabled:opacity-50"
            >
              {creating ? (
                <Loader2Icon className="size-4 animate-spin" strokeWidth={1.5} />
              ) : (
                <FilePlusIcon className="size-4" strokeWidth={1.5} />
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom">New note  ⌘N</TooltipContent>
          </Tooltip>
          {onTemplatesClick ? (
            <Tooltip>
              <TooltipTrigger
                aria-label="New from template"
                data-testid="open-templates"
                onClick={onTemplatesClick}
                className="text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent flex size-7 items-center justify-center rounded-lg transition-colors pointer-coarse:size-10 focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden"
              >
                <LayoutTemplateIcon className="size-4" strokeWidth={1.5} />
              </TooltipTrigger>
              <TooltipContent side="bottom">New from template</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              aria-label="Upload document"
              render={<button type="button" disabled={!canCreate} />}
              onClick={onUploadClick}
              className="text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent flex size-7 items-center justify-center rounded-lg transition-colors pointer-coarse:size-10 focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-hidden disabled:opacity-50"
            >
              <UploadIcon className="size-4" strokeWidth={1.5} />
            </TooltipTrigger>
            <TooltipContent side="bottom">Upload document</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-4">
          {notes.length === 0 ? (
            <>
              <SectionHeading label="Notes" count={0} />
              <p className="text-label px-3 py-2 text-[12px] leading-relaxed">
                No notes yet. Create a note or upload a document.
              </p>
            </>
          ) : (
            sections.map((section) => (
              <NoteSection
                key={section.key}
                section={section}
                collapsed={collapsed[section.key] ?? false}
                onToggle={() => setCollapsed((prev) => ({ ...prev, [section.key]: !prev[section.key] }))}
              >
                {section.notes.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    isActive={note.id === activeId}
                    anchored={anchoredIds?.has(note.id) ?? false}
                    pending={isPending?.(note.id) ?? false}
                    onRename={onRenameNote && canCreate ? onRenameNote : undefined}
                    onDelete={canCreate ? onDeleteNote : undefined}
                  />
                ))}
              </NoteSection>
            ))
          )}

          {failedImports.length > 0 && onRetryImport && onDismissImport ? (
            <FailedImports
              items={failedImports}
              onRetry={canCreate ? onRetryImport : undefined}
              onDismiss={onDismissImport}
            />
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  );
}

type Section = {
  key: string;
  label: string;
  tone: "onchain" | "offchain" | "plain";
  notes: NoteSummary[];
  /** Shown in place of rows when the section has none. */
  empty?: string;
  /** What the section means, on the heading's tooltip. */
  hint?: string;
};

function SectionHeading({
  label,
  count,
  tone = "plain",
  collapsed,
  onToggle,
  hint,
}: {
  label: string;
  count: number;
  tone?: Section["tone"];
  collapsed?: boolean;
  onToggle?: () => void;
  hint?: string;
}) {
  const Icon = tone === "onchain" ? LinkIcon : tone === "offchain" ? Link2OffIcon : null;
  const body = (
    <>
      <ChevronDownIcon
        aria-hidden
        className={cn("text-label size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
        strokeWidth={1.5}
      />
      {Icon ? (
        <Icon
          aria-hidden
          className={cn("size-3 shrink-0", tone === "onchain" ? "text-onchain" : "text-label")}
          strokeWidth={1.75}
        />
      ) : null}
      <span className="eyebrow truncate">{label}</span>
      <span className="text-label ml-auto pr-1 text-[11px] tabular-nums">{count}</span>
    </>
  );
  const className =
    "text-sidebar-foreground/80 flex w-full items-center gap-1.5 px-3 pt-3 pb-1.5 text-[13px]";
  if (!onToggle) return <div className={className}>{body}</div>;

  const button = (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className={cn(
        className,
        "hover:text-foreground focus-visible:ring-ring rounded-md text-left focus-visible:ring-1 focus-visible:outline-hidden focus-visible:ring-inset pointer-coarse:py-3",
      )}
    >
      {body}
    </button>
  );
  if (!hint) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="right" className="max-w-[260px]">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

function NoteSection({
  section,
  collapsed,
  onToggle,
  children,
}: {
  section: Section;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={`${section.label} notes`} data-testid={`notes-${section.key}`}>
      <SectionHeading
        label={section.label}
        count={section.notes.length}
        tone={section.tone}
        collapsed={collapsed}
        onToggle={onToggle}
        hint={section.hint}
      />
      {collapsed ? null : section.notes.length === 0 ? (
        section.empty ? <p className="text-label px-3 pt-0.5 pb-2 pl-8 text-[12px]">{section.empty}</p> : null
      ) : (
        <ul>{children}</ul>
      )}
    </section>
  );
}

function NoteRow({
  note,
  isActive,
  anchored,
  pending,
  onRename,
  onDelete,
}: {
  note: NoteSummary;
  isActive: boolean;
  anchored: boolean;
  pending: boolean;
  onRename?: (note: NoteSummary) => void;
  onDelete?: (note: NoteSummary) => void;
}) {
  return (
    <li
      className={cn(
        "group mx-2 my-px flex items-center rounded-lg border pr-1 text-[13px] transition-colors pointer-coarse:text-[15px]",
        // The active note is a raised glass row, lit from above.
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground border-[var(--glass-lo)] shadow-[inset_0_1px_0_0_var(--glass-hi)]"
          : "text-sidebar-foreground border-transparent hover:bg-[var(--glass)] hover:text-foreground",
      )}
    >
      <NavLink
        href={`/vault/${note.id}`}
        aria-current={isActive ? "page" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-[5px] pl-2.5 pointer-coarse:gap-3 pointer-coarse:py-3"
      >
        <FileTextIcon
          className={cn("size-3.5 shrink-0", isActive ? "text-foreground" : "opacity-60")}
          strokeWidth={1.5}
        />
        <span className="truncate">{note.title}</span>
      </NavLink>
      {onRename ? <RenameRowAction note={note} pending={pending} onRename={onRename} /> : null}
      <NoteRowAction note={note} anchored={anchored} pending={pending} onDelete={onDelete} />
    </li>
  );
}

/**
 * Imports that never became notes. The original file is still archived, so
 * each one can be re-run without finding the file again, or dismissed. A
 * retry lands in the workspace shown, so without `onRetry` (a viewer there)
 * only dismissing is offered; the rows are the user's own either way.
 */
function FailedImports({
  items,
  onRetry,
  onDismiss,
}: {
  items: FailedImport[];
  onRetry?: (target: RetryTarget) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div className="mt-3">
      <div className="text-sidebar-foreground/80 flex items-center gap-1.5 px-3 pt-3 pb-1.5 text-[13px]">
        <TriangleAlertIcon className="text-destructive size-3 shrink-0" strokeWidth={1.5} />
        <span className="eyebrow truncate">Failed imports</span>
        <span className="text-label ml-auto pr-1 text-[11px] tabular-nums">{items.length}</span>
      </div>
      <ul>
        {items.map((item) => (
          <li
            key={item.id}
            className="text-sidebar-foreground flex items-center gap-1 py-[3px] pr-1 pl-4 text-[13px]"
          >
            <span className="min-w-0 flex-1 truncate" title={item.error_code ?? "Interrupted"}>
              {item.filename}
            </span>
            {onRetry ? (
              <button
                type="button"
                aria-label={`Retry import of ${item.filename}`}
                onClick={() => onRetry({ ingestId: item.id, filename: item.filename })}
                className="text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent flex size-6 items-center justify-center rounded-lg pointer-coarse:size-10"
              >
                <RotateCcwIcon className="size-3.5" strokeWidth={1.5} />
              </button>
            ) : null}
            <button
              type="button"
              aria-label={`Dismiss failed import of ${item.filename}`}
              onClick={() => onDismiss(item.id)}
              className="text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent flex size-6 items-center justify-center rounded-lg pointer-coarse:size-10"
            >
              <XIcon className="size-3.5" strokeWidth={1.5} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Rename sits before the delete/on-chain control and shows on every row:
 * a rename leaves the note's text alone, so anchored notes can be renamed too.
 */
function RenameRowAction({
  note,
  pending,
  onRename,
}: {
  note: NoteSummary;
  pending: boolean;
  onRename: (note: NoteSummary) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`Rename ${note.title}`}
        // TooltipTrigger's own `disabled` only stops the tooltip; the button needs it.
        render={<button type="button" disabled={pending} />}
        onClick={() => onRename(note)}
        className="text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent focus-visible:ring-ring flex size-6 shrink-0 items-center justify-center rounded-lg opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:size-10 pointer-coarse:opacity-70 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-40"
      >
        <PencilIcon className="size-3.5" strokeWidth={1.5} />
      </TooltipTrigger>
      <TooltipContent side="right">Rename note</TooltipContent>
    </Tooltip>
  );
}

/**
 * The trailing control on a note row: delete, or — for a note that is anchored
 * — a greyed-out chain in its place.
 *
 * The registry contract has no delete, so an anchored note's ledger entry and
 * its public /d/[docId] page outlive anything this app could remove. Showing a
 * disabled marker says that, where hiding the button would read as a bug and
 * an enabled one would promise an erasure that cannot happen.
 */
function NoteRowAction({
  note,
  anchored,
  pending,
  onDelete,
}: {
  note: NoteSummary;
  anchored: boolean;
  pending: boolean;
  onDelete?: (note: NoteSummary) => void;
}) {
  if (anchored) {
    // The section heading already says "On-chain"; this only explains, on
    // hover, why the row has no delete. Touch has no hover, so it is left out.
    return (
      <Tooltip>
        {/* A span, not a disabled button: a disabled button swallows the
            hover that opens the tooltip explaining why it is disabled. */}
        <TooltipTrigger
          render={<span />}
          role="img"
          aria-label={`${note.title} is anchored on Stellar and cannot be deleted`}
          className="text-onchain flex size-6 shrink-0 items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:hidden"
        >
          <LinkIcon className="size-3.5" strokeWidth={1.75} />
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[260px]">
          Anchored on Stellar. The on-chain record cannot be deleted, so this
          note stays with it.
        </TooltipContent>
      </Tooltip>
    );
  }

  if (!onDelete) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`Delete ${note.title}`}
        render={<button type="button" disabled={pending} />}
        onClick={() => onDelete(note)}
        className="text-sidebar-foreground/70 hover:text-destructive hover:bg-sidebar-accent focus-visible:ring-ring flex size-6 shrink-0 items-center justify-center rounded-lg opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:size-10 pointer-coarse:opacity-70 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-40"
      >
        <Trash2Icon className="size-3.5" strokeWidth={1.5} />
      </TooltipTrigger>
      <TooltipContent side="right">Delete note</TooltipContent>
    </Tooltip>
  );
}
