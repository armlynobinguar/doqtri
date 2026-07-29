"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GraphPanel } from "@/components/vault/graph-panel";
import { MindmapPanel } from "@/components/vault/mindmap-panel";
import { BacklinksList } from "@/components/vault/backlinks-list";
import { ShipPanel } from "@/components/vault/ship-panel";
import { useVaultStatus, type RightTab } from "@/components/vault/vault-status";
import type { DocMindmap } from "@/lib/mindmap-types";
import type { Doc } from "@/lib/types";

export function RightPanel({
  docs,
  activeId,
  title,
  markdown,
  mindmap,
  mindmapStale,
}: {
  /** All notes, with the active one carrying the live editor text. */
  docs: Doc[];
  activeId: string;
  title: string;
  markdown: string;
  /** The active note's stored concept map, null when it has none. */
  mindmap: DocMindmap | null;
  mindmapStale: boolean;
}) {
  const { rightTab, setRightTab } = useVaultStatus();

  return (
    <div className="bg-muted flex h-full min-h-0 flex-col">
      <div className="border-border flex h-9 shrink-0 items-center border-b px-1">
        <Tabs
          value={rightTab}
          onValueChange={(value) => setRightTab(value as RightTab)}
        >
          <TabsList variant="line" className="h-8 bg-transparent">
            <TabsTrigger
              value="graph"
              className="data-active:text-foreground text-muted-foreground px-2.5 text-[12px] after:bg-primary!"
            >
              Graph
            </TabsTrigger>
            <TabsTrigger
              value="mindmap"
              className="data-active:text-foreground text-muted-foreground px-2.5 text-[12px] after:bg-primary!"
            >
              Mindmap
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/*
        Rendered conditionally rather than with TabsContent so the force
        simulation is not left running behind the mindmap.
      */}
      {/*
        A flex column, not a plain block: both panels size themselves with
        `flex-1`, and the graph measures its own height to size the canvas. In a
        block parent that measurement resolves to 0 and the graph never paints.
      */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {rightTab === "graph" ? (
          <GraphPanel docs={docs} activeId={activeId} />
        ) : (
          <MindmapPanel
            docId={activeId}
            title={title}
            markdown={markdown}
            mindmap={mindmap}
            stale={mindmapStale}
          />
        )}
      </div>

      <BacklinksList docs={docs} activeId={activeId} />
      <ShipPanel docId={activeId} title={title} markdown={markdown} />
    </div>
  );
}
