"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLinkIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  mindmapFromHeadings,
  type ConceptNode,
  type DocMindmap,
} from "@/lib/mindmap-types";

/**
 * The compact mindmap: the document's concept tree, in the right-hand panel.
 *
 * The panel is a few hundred pixels wide, which is too narrow for the canvas,
 * so this stays a tree and links out to the full view. Where the tree comes
 * from is the whole point of the feature: the stored concept map when there is
 * one, and the heading hierarchy only as a fallback — headings alone say
 * almost nothing about a document that has none.
 */
export function MindmapPanel({
  docId,
  title,
  markdown,
  mindmap,
  stale,
}: {
  docId: string;
  title: string;
  markdown: string;
  mindmap: DocMindmap | null;
  stale: boolean;
}) {
  const router = useRouter();
  const [building, setBuilding] = useState(false);

  const fallback = useMemo(
    () => mindmapFromHeadings(title, markdown),
    [title, markdown],
  );
  const tree = mindmap ?? fallback;
  const derived = mindmap === null;

  async function rebuild() {
    setBuilding(true);
    try {
      const res = await fetch("/api/mindmap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: docId }),
      });
      const payload: unknown = await res.json().catch(() => null);

      if (!res.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error: unknown }).error)
            : `Could not build the mindmap (${res.status})`;
        throw new Error(message);
      }

      toast.success("Mindmap rebuilt");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Mindmap failed");
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border/60 flex h-7 shrink-0 items-center justify-between gap-1 border-b px-2">
        <span className="text-label truncate text-[11px]">
          {derived ? "From headings" : stale ? "Note has changed" : "Concept map"}
        </span>

        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              aria-label={derived ? "Build mindmap" : "Rebuild mindmap"}
              disabled={building}
              onClick={rebuild}
              className={
                // Purple is reserved for AI affordances, and this is one.
                "text-accent/80 hover:text-accent hover:bg-accent/10 flex size-5 items-center justify-center rounded transition-colors disabled:opacity-50 " +
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

          <Tooltip>
            <TooltipTrigger
              render={
                <Link
                  href={`/vault/${docId}/mindmap`}
                  aria-label="Open full mindmap"
                  className="text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10 flex size-5 items-center justify-center rounded transition-colors"
                >
                  <ExternalLinkIcon className="size-3" strokeWidth={2} />
                </Link>
              }
            />
            <TooltipContent side="bottom">Open full mindmap</TooltipContent>
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
