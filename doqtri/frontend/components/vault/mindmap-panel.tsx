"use client";

import { useMemo } from "react";
import { NavLink } from "@/components/vault/navigation";
import { Loader2Icon, Maximize2Icon, RefreshCwIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { mindmapFromHeadings, type ConceptNode } from "@/lib/mindmap-types";
import { withRootLabel, type MindmapRebuild } from "@/components/vault/use-mindmap-rebuild";
import { useDraftTitle } from "@/components/vault/note-overlay";

/**
 * The compact mindmap: the document's concept tree, in the right-hand panel.
 *
 * The panel is a few hundred pixels wide, which is too narrow for the canvas,
 * so this stays a tree, with a full-width button under it for the full view —
 * an icon in the header was too easy to miss. Where the tree comes
 * from is the whole point of the feature: the stored concept map when there is
 * one, and the heading hierarchy only as a fallback — headings alone say
 * almost nothing about a document that has none.
 *
 * The concept map and its rebuild come from the note's workspace, shared with
 * the live mindmap beside the editor; see useMindmapRebuild.
 */
export function MindmapPanel({
  docId,
  title: confirmedTitle,
  markdown,
  concept,
}: {
  docId: string;
  title: string;
  markdown: string;
  concept: MindmapRebuild;
}) {
  // The root shows a title being typed into the note's title line (DOQ-44).
  const title = useDraftTitle(docId, confirmedTitle);
  const { mindmap, stale, building, rebuild } = concept;

  const fallback = useMemo(
    () => mindmapFromHeadings(title, markdown),
    [title, markdown],
  );
  const tree = mindmap ? withRootLabel(mindmap, title) : fallback;
  const derived = mindmap === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border/60 flex h-7 shrink-0 items-center justify-between gap-1 border-b px-2 pointer-coarse:h-10">
        <span className="text-label truncate text-[11px]">
          {derived ? "From headings" : stale ? "Note has changed" : "Concept map"}
        </span>

        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              aria-label={derived ? "Build mindmap" : "Rebuild mindmap"}
              render={<button type="button" disabled={building} />}
              onClick={rebuild}
              className={
                // The muted lavender is reserved for AI affordances, and this is one.
                "text-accent/80 hover:text-accent flex size-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--glass-strong)] pointer-coarse:size-9 disabled:opacity-50 " +
                (derived || stale ? "" : "opacity-60")
              }
            >
              {building ? (
                <Loader2Icon className="size-3 animate-spin" strokeWidth={2} />
              ) : (
                <RefreshCwIcon className="size-3" strokeWidth={2} />
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {derived
                ? "Build a concept mindmap with AI"
                : "Rebuild this mindmap from the current note"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div data-testid="mindmap" className="px-3 py-2">
          <p className="text-foreground truncate text-[13px] font-medium">
            {tree.root.label}
          </p>

          {tree.root.children.length === 0 ? (
            <p className="text-label mt-2 text-[12px] leading-relaxed">
              No mindmap yet. Use{" "}
              <span className="text-accent">rebuild</span> to generate one, or add
              a <code className="font-mono">## Heading</code> to grow the tree.
            </p>
          ) : (
            <Branch nodes={tree.root.children} depth={0} />
          )}
        </div>
      </ScrollArea>

      <div className="border-border/60 shrink-0 border-t p-2">
        <NavLink
          href={`/vault/${docId}/mindmap`}
          className={buttonVariants({ variant: "outline", size: "sm", className: "w-full max-lg:h-10" })}
        >
          <Maximize2Icon strokeWidth={1.5} />
          Open full mindmap
        </NavLink>
      </div>
    </div>
  );
}

function Branch({ nodes, depth }: { nodes: ConceptNode[]; depth: number }) {
  return (
    <ul
      className={
        depth === 0
          ? "mt-1.5 flex flex-col"
          : "border-border/70 mt-0.5 flex flex-col border-l pl-2.5"
      }
    >
      {nodes.map((node) => (
        <li key={node.id} className="py-[1px]">
          <span
            title={node.summary}
            className={
              depth === 0
                ? "text-muted-foreground text-[12.5px]"
                : "text-muted-foreground/80 text-[12px]"
            }
          >
            {node.label}
          </span>
          {node.children.length > 0 && (
            <Branch nodes={node.children} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}
