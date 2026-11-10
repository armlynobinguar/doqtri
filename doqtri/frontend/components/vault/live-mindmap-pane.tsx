"use client";

import { useMemo, useState } from "react";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MindmapCanvas } from "@/components/vault/mindmap-canvas";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { withRootLabel, type MindmapRebuild } from "@/components/vault/use-mindmap-rebuild";
import { graphFromMindmap, type MindmapGraph } from "@/lib/mindmap-graph";
import { withLabelPathIds } from "@/lib/mindmap-live";
import { DEFAULT_STYLE, type MindmapStyle } from "@/lib/mindmap-style";
import { mindmapFromHeadings, type ConceptNode } from "@/lib/mindmap-types";
import { cn } from "@/lib/utils";

/** How long typing must pause before the heading map is rebuilt. */
const REBUILD_MS = 250;

/** The full map's default look, laid out as rings around the note. */
const LIVE_LOOK: MindmapStyle = { ...DEFAULT_STYLE, layout: "radial" };

type View = "headings" | "concept";

/**
 * The note's mindmap beside the editor, drawn from what is being typed.
 *
 * Headings (the default) is the heading tree of the live text, rebuilt a
 * moment after typing pauses: a new `## Heading` becomes a node without a
 * save. Nodes are matched by their heading path, so the map holds still while
 * it grows (see lib/mindmap-live.ts). Concept map shows the stored AI map,
 * when the note has one, with the same stale hint and Rebuild as the right
 * panel's Mindmap tab — the live tree is never replaced by it. Without a
 * stored map there is nothing to switch to, and no switch. The concept map
 * and its rebuild are the workspace's, shared with the right panel, so a
 * rebuild here shows there too (and the other way round) without a reload.
 */
export function LiveMindmapPane({
  title,
  markdown,
  concept,
}: {
  title: string;
  /** The editor's live text. */
  markdown: string;
  /** The AI concept map (null when the note has none) and its rebuild. */
  concept: MindmapRebuild;
}) {
  const { stale, building, rebuild } = concept;
  // The root shows the note's title now, so a rename (pending or done) reaches it.
  const mindmap = useMemo(
    () => (concept.mindmap ? withRootLabel(concept.mindmap, title) : null),
    [concept.mindmap, title],
  );
  const [chosen, setChosen] = useState<View>("headings");
  const view: View = mindmap ? chosen : "headings";

  const settled = useDebouncedValue(markdown, REBUILD_MS);
  const fresh = useMemo(() => withLabelPathIds(mindmapFromHeadings(title, settled)), [title, settled]);
  // Most pauses in typing change prose, not headings. Keyed on the tree's
  // shape and labels, the map keeps its identity then, so the canvas does
  // not reheat its layout for nothing.
  const shape = useMemo(() => treeKey(fresh.root), [fresh]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `shape` stands for `fresh`
  const headings = useMemo(() => fresh, [shape]);
  const headingGraph = useMemo(() => graphFromMindmap(headings), [headings]);
  const conceptGraph = useMemo(() => (mindmap ? graphFromMindmap(mindmap) : null), [mindmap]);

  const tree = view === "concept" && mindmap ? mindmap : headings;
  const graph: MindmapGraph = view === "concept" && conceptGraph ? conceptGraph : headingGraph;
  const empty = tree.root.children.length === 0;

  return (
    <section aria-label="Live mindmap" data-testid="live-mindmap" className="bg-background flex h-full min-h-0 flex-col">
      <div className="border-border/60 flex h-10 shrink-0 items-center justify-between gap-2 border-b px-2 pointer-coarse:h-12">
        {mindmap ? (
          <Tabs value={view} onValueChange={(value) => setChosen(value as View)}>
            <TabsList className="h-8">
              <TabsTrigger value="headings" className="text-muted-foreground px-2.5 text-[12px]">
                Headings
              </TabsTrigger>
              <TabsTrigger value="concept" className="text-muted-foreground px-2.5 text-[12px]">
                Concept map
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : (
          // No stored map: nothing to switch to, so no switch.
          <span className="text-label px-1 text-[11px]">From headings</span>
        )}

        {view === "concept" && (
          <div className="flex min-w-0 items-center gap-1">
            <span className="text-label truncate text-[11px]" aria-live="polite">
              {stale ? "Note has changed" : "Up to date"}
            </span>
            <Tooltip>
              <TooltipTrigger
                aria-label="Rebuild mindmap"
                render={<button type="button" disabled={building} />}
                onClick={rebuild}
                className={cn(
                  // The muted lavender is reserved for AI affordances, and this is one.
                  "text-accent/80 hover:text-accent focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150 hover:bg-[var(--glass-strong)] focus-visible:ring-1 focus-visible:outline-hidden disabled:opacity-50 pointer-coarse:size-11",
                  !stale && "opacity-60",
                )}
              >
                {building ? (
                  <Loader2Icon className="size-3.5 animate-spin" strokeWidth={2} />
                ) : (
                  <RefreshCwIcon className="size-3.5" strokeWidth={2} />
                )}
              </TooltipTrigger>
              <TooltipContent side="bottom">Rebuild this mindmap from the current note</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {/* The canvas says nothing to a screen reader; the outline does. */}
      <Outline root={tree.root} />

      {empty ? (
        <p className="text-label flex flex-1 items-center justify-center px-6 text-center text-[12px] leading-relaxed">
          <span>
            No mindmap yet. Add a <code className="font-mono">## Heading</code> to grow the tree.
          </span>
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Remounted per view: the two maps share no layout worth keeping. */}
          <MindmapCanvas key={view} graph={graph} look={LIVE_LOOK} stableLayout={view === "headings"} />
        </div>
      )}
    </section>
  );
}

/** The tree's ids and labels, in order: equal exactly when the map would draw the same. */
function treeKey(root: ConceptNode): string {
  type Shape = [string, string, Shape[]];
  const shape = (node: ConceptNode): Shape => [node.id, node.label, node.children.map(shape)];
  return JSON.stringify(shape(root));
}

function Outline({ root }: { root: ConceptNode }) {
  const walk = (nodes: ConceptNode[]) => (
    <ul>
      {nodes.map((node) => (
        <li key={node.id}>
          {node.label}
          {node.children.length > 0 && walk(node.children)}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="sr-only" data-testid="live-mindmap-outline">
      <p>{root.label}</p>
      {walk(root.children)}
    </div>
  );
}
