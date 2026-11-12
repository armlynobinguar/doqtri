"use client";

import { useMemo } from "react";
import Link from "next/link";
import { EyeIcon } from "lucide-react";
import { DoqtriMark } from "@/components/brand/doqtri-mark";
import { ReadOnlyMindmapStudio } from "@/components/vault/mindmap-studio";
import { sharedMindmapStyle } from "@/lib/mindmap-share-view";
import type { MindmapGraph } from "@/lib/mindmap-graph";
import { MINDMAP_COLORS } from "@/lib/theme";

/**
 * The shared mindmap (/m/<token>, WP-4.7, DOQ-53): a workspace's global
 * mindmap frozen as it was sent to a qdit hackathon, for anyone with the
 * link. Zoom, pan, search and 2D or 3D, with the sender's look; nothing can be
 * edited, restyled or opened, and the page holds labels only, never note text.
 */
export function SharedMindmap({
  graph,
  style: rawStyle,
  createdAt,
}: {
  graph: MindmapGraph;
  style: unknown;
  createdAt: string;
}) {
  const style = useMemo(() => sharedMindmapStyle(rawStyle, graph.nodes.length), [rawStyle, graph.nodes.length]);
  const noteCount = graph.nodes.filter((node) => node.kind === "document").length;
  const conceptCount = graph.nodes.filter((node) => node.kind === "concept" || node.kind === "hub").length;
  const sent = sentOn(createdAt);

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <header className="border-border bg-background flex h-11 shrink-0 items-center justify-between gap-3 border-b px-3 pt-[env(safe-area-inset-top)]">
        <div className="flex min-w-0 items-center gap-2">
          <Link href="/" aria-label="Doqtri" className="text-foreground flex shrink-0">
            <DoqtriMark title="" className="h-5 w-auto" />
          </Link>
          <h1 className="text-foreground truncate text-[14px] font-semibold tracking-tight">Shared mindmap</h1>
          <span className="text-label flex shrink-0 items-center gap-1 text-[11px] max-sm:hidden">
            <EyeIcon className="size-3.5" strokeWidth={1.5} />
            Read-only{sent ? ` · sent ${sent}` : ""}
          </span>
        </div>
        <div className="text-label flex shrink-0 items-center gap-3 text-[11px]">
          <span className="max-[420px]:hidden">
            {noteCount} {noteCount === 1 ? "note" : "notes"}
          </span>
          <span>
            {conceptCount} {conceptCount === 1 ? "concept" : "concepts"}
          </span>
          <Legend color={MINDMAP_COLORS.document.stroke} label="Note" />
          <Legend color={MINDMAP_COLORS.hub.stroke} label="Shared" />
        </div>
      </header>

      <ReadOnlyMindmapStudio
        title="Global mindmap"
        graph={graph}
        style={style}
        emptyMessage="This mindmap has no nodes."
      />
    </div>
  );
}

/** The day the link was made, in the viewer's own locale; null when unreadable. */
function sentOn(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 max-sm:hidden">
      <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
