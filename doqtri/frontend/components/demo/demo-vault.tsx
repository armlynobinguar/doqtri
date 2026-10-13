"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { FileTextIcon, LockIcon, NetworkIcon } from "lucide-react";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { DoqtriLoader } from "@/components/brand/doqtri-loader";
import { MindmapStudio } from "@/components/vault/mindmap-studio";
import { graphFromMindmap } from "@/lib/mindmap-graph";
import { mindmapFromHeadings } from "@/lib/mindmap-types";
import type { DemoNote } from "@/lib/demo-vault";
import { cn } from "@/lib/utils";

// The editor's own renderer, so a demo note reads exactly like a vault note.
const Markdown = dynamic(() => import("@uiw/react-md-editor").then((m) => m.default.Markdown), {
  ssr: false,
  loading: () => (
    <div className="flex h-40 items-center justify-center">
      <DoqtriLoader messages={false} className="size-10" />
    </div>
  ),
});

/** The phone layout shows one pane at a time. */
type View = "note" | "map";

const primary =
  "inline-flex h-8 items-center rounded-lg bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-90";
const secondary =
  "inline-flex h-8 items-center rounded-lg border border-border px-3 text-xs font-medium transition-colors hover:bg-[var(--glass-strong)]";

/**
 * A read-only vault for visitors: the explorer, the note and its mindmap, with
 * nothing that writes. Anchoring is shown as the next step after signing up.
 */
export function DemoVault({ notes, active }: { notes: readonly DemoNote[]; active: DemoNote }) {
  const [view, setView] = useState<View>("note");
  const graph = useMemo(
    () => graphFromMindmap(mindmapFromHeadings(active.title, active.markdown)),
    [active.title, active.markdown],
  );

  return (
    <div className="bg-background text-foreground flex h-dvh min-h-0 w-full flex-col overflow-hidden">
      <header className="border-border flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link href="/" aria-label="Doqtri home" className="flex items-center gap-2">
            <DoqtriMark className="size-6" glow={false} />
            <span className="text-sm font-semibold">Doqtri</span>
          </Link>
          <span className="border-border text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]">
            <LockIcon className="size-3" strokeWidth={1.5} />
            Demo vault · read-only
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link href="/login" className={cn(secondary, "max-sm:hidden")}>
            Open your vault
          </Link>
          <Link href="/signup" className={primary}>
            Sign up free
          </Link>
        </div>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1 max-lg:flex-col">
        {/* Explorer: a column on desktop, a scrolling strip on phones. */}
        <nav
          aria-label="Demo notes"
          className="border-border shrink-0 border-r p-2 lg:w-64 lg:overflow-y-auto max-lg:flex max-lg:gap-1.5 max-lg:overflow-x-auto max-lg:border-r-0 max-lg:border-b"
        >
          <p className="text-muted-foreground px-2 pb-2 text-[11px] tracking-wide uppercase max-lg:hidden">Notes</p>
          {notes.map((note) => (
            <Link
              key={note.id}
              href={`/demo/${note.id}`}
              aria-current={note.id === active.id ? "page" : undefined}
              className={cn(
                "flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-[var(--glass-strong)] max-lg:shrink-0 max-lg:whitespace-nowrap",
                note.id === active.id && "bg-[var(--glass-strong)] font-medium",
              )}
            >
              <FileTextIcon className="mt-0.5 size-3.5 shrink-0 opacity-70" strokeWidth={1.5} />
              <span className="min-w-0">
                <span className="block truncate">{note.title}</span>
                <span className="text-muted-foreground block text-[11px] leading-snug font-normal max-lg:hidden">
                  {note.description}
                </span>
              </span>
            </Link>
          ))}
        </nav>

        <div className="border-border flex shrink-0 gap-1 border-b p-1.5 lg:hidden" role="tablist">
          {(["note", "map"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn(
                "flex-1 rounded-lg py-1 text-xs",
                view === v ? "bg-[var(--glass-strong)] font-medium" : "text-muted-foreground",
              )}
            >
              {v === "note" ? "Note" : "Map"}
            </button>
          ))}
        </div>

        <main className="flex min-h-0 min-w-0 flex-1">
          <article
            aria-label={active.title}
            className={cn(
              "border-border min-w-0 flex-1 overflow-x-hidden overflow-y-auto border-r px-6 py-5 break-words lg:max-w-[50%] max-lg:border-r-0 max-lg:px-4",
              view !== "note" && "max-lg:hidden",
            )}
          >
            <Markdown source={active.markdown} style={{ background: "transparent" }} />
            <aside className="border-border mt-8 rounded-xl border p-4 text-sm">
              <p className="font-medium">Save &amp; anchor is turned off in the demo</p>
              <p className="text-muted-foreground mt-1">
                In your own vault, one click writes this note&apos;s hash to Stellar and gives it a public audit page.
                Sign up with email to get a passkey wallet, or connect Freighter.
              </p>
              <div className="mt-3 flex gap-2">
                <Link href="/signup" className={primary}>
                  Start your vault
                </Link>
                <Link href="/docs" className={secondary}>
                  How anchoring works
                </Link>
              </div>
            </aside>
          </article>

          <section
            aria-label={`${active.title} mindmap`}
            className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", view !== "map" && "max-lg:hidden")}
          >
            <div className="text-muted-foreground pointer-events-none absolute top-2 left-3 z-10 flex items-center gap-1.5 text-[11px]">
              <NetworkIcon className="size-3.5" strokeWidth={1.5} />
              Mindmap from this note&apos;s headings
            </div>
            <MindmapStudio
              scope={`demo:${active.id}`}
              title={active.title}
              defaultLayout="radial"
              graph={graph}
              emptyMessage="This note has no headings to map."
            />
          </section>
        </main>
      </div>
    </div>
  );
}
