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
  onSave,
  showShip = true,
}: {
  /** All notes, with the active one carrying the live editor text. */
  docs: Doc[];
  activeId: string;
  title: string;
  markdown: string;
  /** The active note's stored concept map, null when it has none. */
  mindmap: DocMindmap | null;
  mindmapStale: boolean;
  /** Saves the note now and resolves with the text stored; see ShipPanel. */
  onSave: () => Promise<string>;
  /** Off on phones, where the ship panel is a view of its own. */
  showShip?: boolean;
}) {
  const { rightTab, setRightTab } = useVaultStatus();

  return (
    <div className="bg-sidebar flex h-full min-h-0 flex-col">
      <div className="border-border flex h-11 shrink-0 items-center border-b px-2">
        <Tabs
          value={rightTab}
          onValueChange={(value) => setRightTab(value as RightTab)}
        >
          <TabsList className="h-8">
            <TabsTrigger
              value="graph"
              className="text-muted-foreground px-3 text-[12px]"
            >
              Graph
            </TabsTrigger>
            <TabsTrigger
              value="mindmap"
              className="text-muted-foreground px-3 text-[12px]"
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
      {/*
        Everything under the tabs scrolls as one column. The graph keeps a floor
        height so a tall ship panel scrolls into view instead of crushing the
        canvas to nothing (and clipping the controls below it).
      */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex min-h-64 flex-1 flex-col overflow-hidden">
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
        {showShip && (
          <div className="shrink-0">
            <ShipPanel docId={activeId} title={title} markdown={markdown} onSave={onSave} />
          </div>
        )}
      </div>
    </div>
  );
}
