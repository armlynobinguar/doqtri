"use client";

import { useMemo } from "react";
import { MindmapCanvas } from "@/components/vault/mindmap-canvas";
import { buildGlobalMindmap } from "@/lib/global-mindmap";
import { MINDMAP_COLORS } from "@/lib/theme";
import type { Doc } from "@/lib/types";
import { useNavigate } from "@/components/vault/navigation";

/**
 * The vault-wide mindmap. Concepts from every document in one map, with the
 * ones several documents reach drawn as hubs.
 */
export function GlobalMindmap({ docs }: { docs: Doc[] }) {
  const navigate = useNavigate();
  const graph = useMemo(() => buildGlobalMindmap(docs), [docs]);

  const documentCount = docs.length;
  const hubCount = graph.nodes.filter((node) => node.kind === "hub").length;
  const conceptCount = graph.nodes.filter(
    (node) => node.kind === "concept" || node.kind === "hub",
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-border bg-background flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3 max-lg:justify-center">
        {/* The mobile top bar already names the view. */}
        <h1 className="text-foreground truncate text-[13px] font-medium max-lg:sr-only">
          Global mindmap
        </h1>

        <div className="text-label flex shrink-0 items-center gap-3 text-[11px]">
          <span className="max-lg:hidden">Drag to arrange · right-click to release</span>
          <span className="max-[380px]:hidden">
            {documentCount} {documentCount === 1 ? "note" : "notes"}
          </span>
          <span>
            {conceptCount} {conceptCount === 1 ? "concept" : "concepts"}
          </span>
          <Legend color={MINDMAP_COLORS.document.stroke} label="Note" />
          <Legend
            color={MINDMAP_COLORS.hub.stroke}
            label={`Shared (${hubCount})`}
          />
        </div>
      </header>

      <MindmapCanvas
        graph={graph}
        // A forest, not one tree: several notes are roots, so rings would stack
        // them on top of each other instead of spreading them out.
        layout="free"
        onNodeClick={(node) => {
          if (node.href) navigate(node.href);
        }}
        // Only notes open anything; concepts and hubs are labels.
        isClickable={(node) => Boolean(node.href)}
        emptyMessage="Upload a document to start the global mindmap."
      />
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}
