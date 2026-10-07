"use client";

import { useMemo } from "react";
import { GraphPanel } from "@/components/vault/graph-panel";
import { buildGraph } from "@/lib/wikilinks";
import type { Doc } from "@/lib/types";

/**
 * The vault-wide link graph. The same graph the right panel shows beside a
 * note, but with the whole pane to spread out in.
 */
export function GlobalGraph({ docs }: { docs: Doc[] }) {
  const { nodes, edges } = useMemo(() => buildGraph(docs), [docs]);

  const noteCount = docs.length;
  const linkCount = edges.length;
  const unresolvedCount = nodes.filter((node) => node.ghost).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-border bg-background flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3 max-lg:justify-center">
        {/* The mobile top bar already names the view. */}
        <h1 className="text-foreground truncate text-[14px] font-semibold tracking-tight max-lg:sr-only">
          Graph view
        </h1>

        <div className="text-label flex shrink-0 items-center gap-3 text-[11px]">
          <span className="max-lg:hidden">Click a note to open it · scroll to zoom</span>
          <span className="lg:hidden">Tap a note · pinch to zoom</span>
          <span>
            {noteCount} {noteCount === 1 ? "note" : "notes"}
          </span>
          <span>
            {linkCount} {linkCount === 1 ? "link" : "links"}
          </span>
          {unresolvedCount > 0 && (
            <span className="max-sm:hidden">{unresolvedCount} unresolved</span>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <GraphPanel docs={docs} />
      </div>
    </div>
  );
}
