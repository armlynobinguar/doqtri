"use client";

import Link from "next/link";
import {
  BrainIcon,
  CheckIcon,
  FilePlusIcon,
  FilesIcon,
  Loader2Icon,
  NetworkIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import type { RibbonAction } from "@/components/vault/ribbon";
import type { SaveState } from "@/components/vault/status-bar";
import { cn } from "@/lib/utils";

/*
 * The vault's chrome below the `lg` breakpoint: phones and portrait tablets.
 * The desktop ribbon, resizable explorer and right panel take ~500px before the
 * editor gets any room, so there they are swapped for a top bar (where am I, did it save) and a bottom
 * tab bar (where can I go), with the explorer in a drawer. Both are hidden with
 * CSS rather than a JS breakpoint so the server-rendered HTML is already right.
 */

export function MobileTopBar({
  title,
  saveState,
  creating,
  onNewNote,
}: {
  title: string;
  saveState: SaveState;
  creating: boolean;
  onNewNote: () => void;
}) {
  return (
    <header className="bg-sidebar border-border flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b pt-[env(safe-area-inset-top)] pr-1.5 pl-2 lg:hidden">
      <Link
        href="/"
        aria-label="Doqtri home"
        className="text-foreground focus-visible:ring-ring flex size-10 shrink-0 items-center justify-center rounded-lg focus-visible:ring-1 focus-visible:outline-hidden"
      >
        <DoqtriMark className="size-7" glow={false} title="" />
      </Link>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 className="text-foreground truncate text-[15px] font-semibold tracking-tight">
          {title}
        </h1>
        <SaveIndicator state={saveState} />
      </div>

      <button
        type="button"
        aria-label="New note"
        disabled={creating}
        onClick={onNewNote}
        className="text-sidebar-foreground hover:text-foreground active:bg-sidebar-accent focus-visible:ring-ring flex size-10 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:ring-1 focus-visible:outline-hidden disabled:opacity-50"
      >
        {creating ? (
          <Loader2Icon className="size-5 animate-spin" strokeWidth={1.5} />
        ) : (
          <FilePlusIcon className="size-5" strokeWidth={1.5} />
        )}
      </button>
    </header>
  );
}

/** The status bar's save state, shrunk to fit beside the title. */
function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  return (
    <span
      role="status"
      className={cn(
        "flex shrink-0 items-center gap-1 text-[12px]",
        state === "error"
          ? "text-destructive"
          : state === "saved"
            ? "text-muted-foreground [&_svg]:text-success"
            : "text-label",
      )}
    >
      {state === "saving" ? (
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
      ) : state === "saved" ? (
        <CheckIcon className="size-3.5" strokeWidth={2.25} aria-hidden />
      ) : null}
      {state === "saving" ? "Saving" : state === "saved" ? "Saved" : "Save failed"}
    </span>
  );
}

const TABS: { id: RibbonAction; label: string; Icon: typeof FilesIcon }[] = [
  { id: "files", label: "Notes", Icon: FilesIcon },
  { id: "search", label: "Search", Icon: SearchIcon },
  { id: "graph", label: "Graph", Icon: NetworkIcon },
  { id: "mindmap", label: "Mindmap", Icon: BrainIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
];

export function MobileTabBar({
  active,
  onAction,
}: {
  active?: RibbonAction;
  onAction: (action: RibbonAction) => void;
}) {
  return (
    <nav
      aria-label="Primary"
      className="bg-sidebar border-border grid shrink-0 grid-cols-5 border-t pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {TABS.map(({ id, label, Icon }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            type="button"
            aria-current={isActive ? "page" : undefined}
            onClick={() => onAction(id)}
            className={cn(
              "focus-visible:ring-ring relative flex h-14 flex-col items-center justify-center gap-1 text-[10.5px] font-medium transition-colors focus-visible:ring-1 focus-visible:outline-hidden focus-visible:ring-inset",
              isActive
                ? "text-foreground before:bg-foreground before:absolute before:top-0 before:left-1/2 before:h-0.5 before:w-8 before:-translate-x-1/2 before:rounded-full before:shadow-[0_0_10px_var(--foreground)]"
                : "text-sidebar-foreground/70 active:text-foreground",
            )}
          >
            <Icon
              className={cn("size-5", isActive && "text-foreground")}
              strokeWidth={1.5}
              aria-hidden
            />
            {label}
          </button>
        );
      })}
    </nav>
  );
}
