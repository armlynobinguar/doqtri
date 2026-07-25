"use client";

import { useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { buildMindmap, type MindmapNode } from "@/lib/mindmap";

/**
 * The per-document mindmap: the note's heading hierarchy as a tree. Derived
 * from the markdown on every render, so it can never disagree with the text.
 */
export function MindmapPanel({
  title,
  markdown,
}: {
  title: string;
  markdown: string;
}) {
  const tree = useMemo(() => buildMindmap(title, markdown), [title, markdown]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div data-testid="mindmap" className="px-3 py-2">
        <p className="text-foreground truncate text-[13px] font-medium">
          {tree.label}
        </p>
        {tree.children.length === 0 ? (
          <p className="text-label mt-2 text-[12px] leading-relaxed">
            No headings yet. Add a{" "}
            <code className="font-mono">## Heading</code> to grow the tree.
          </p>
        ) : (
          <Branch nodes={tree.children} depth={0} />
        )}
      </div>
    </ScrollArea>
  );
}

function Branch({ nodes, depth }: { nodes: MindmapNode[]; depth: number }) {
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
