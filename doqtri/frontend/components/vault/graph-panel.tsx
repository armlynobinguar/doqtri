"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { ForceGraphProps, NodeObject } from "react-force-graph-2d";
import { buildGraph, type GraphNode } from "@/lib/wikilinks";
import { GRAPH_COLORS } from "@/lib/theme";
import type { Doc } from "@/lib/types";

type NodeDatum = GraphNode;
type LinkDatum = Record<string, unknown>;

// Touches `window`, so it must never be server-rendered. The generic signature
// does not survive next/dynamic, so it is reapplied here.
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
}) as unknown as React.ComponentType<ForceGraphProps<NodeDatum, LinkDatum>>;

const NODE_RADIUS = 3.5;
const LABEL_ZOOM_THRESHOLD = 1.1;

export function GraphPanel({
  docs,
  activeId,
}: {
  docs: Doc[];
  activeId?: string;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // force-graph mutates node objects with simulation coordinates. Rebuilding
  // the graph on every edit would otherwise reset the layout, so positions are
  // cached by node id and seeded back in.
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const graphData = useMemo(() => {
    const { nodes, edges } = buildGraph(docs);
    const cache = positionsRef.current;

    return {
      nodes: nodes.map((node) => {
        const cached = cache.get(node.id);
        return cached ? { ...node, x: cached.x, y: cached.y } : { ...node };
      }),
      links: edges.map((edge) => ({ source: edge.source, target: edge.target })),
    };
  }, [docs]);

  function rememberPositions(nodes: NodeObject<NodeDatum>[]) {
    const cache = positionsRef.current;
    for (const node of nodes) {
      if (typeof node.x === "number" && typeof node.y === "number") {
        cache.set(String(node.id), { x: node.x, y: node.y });
      }
    }
  }

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
      {graphData.nodes.length === 0 ? (
        <p className="text-label absolute inset-0 flex items-center justify-center px-4 text-center text-[12px]">
          The graph appears once you have a note.
        </p>
      ) : (
        size.width > 0 && (
          <ForceGraph2D
            width={size.width}
            height={size.height}
            graphData={graphData}
            backgroundColor={GRAPH_COLORS.background}
            nodeRelSize={NODE_RADIUS}
            cooldownTicks={80}
            d3AlphaDecay={0.035}
            d3VelocityDecay={0.35}
            linkColor={() => GRAPH_COLORS.link}
            linkWidth={1}
            enableNodeDrag
            onEngineStop={() => rememberPositions(graphData.nodes)}
            onNodeDragEnd={() => rememberPositions(graphData.nodes)}
            onNodeClick={(node: NodeObject<NodeDatum>) => {
              // Ghost nodes have no note behind them yet.
              if (node.ghost) return;
              router.push(`/vault/${String(node.id)}`);
            }}
            nodeCanvasObject={(
              node: NodeObject<NodeDatum>,
              ctx: CanvasRenderingContext2D,
              globalScale: number,
            ) => {
              const x = node.x ?? 0;
              const y = node.y ?? 0;
              const isActive = String(node.id) === activeId;

              ctx.beginPath();
              ctx.arc(x, y, NODE_RADIUS, 0, 2 * Math.PI);

              if (node.ghost) {
                // Hollow and dimmed, like Obsidian's unresolved links.
                ctx.strokeStyle = GRAPH_COLORS.ghostStroke;
                ctx.lineWidth = 0.8;
                ctx.stroke();
              } else {
                ctx.fillStyle = GRAPH_COLORS.node;
                ctx.fill();
              }

              if (isActive) {
                ctx.beginPath();
                ctx.arc(x, y, NODE_RADIUS + 2.5, 0, 2 * Math.PI);
                ctx.strokeStyle = GRAPH_COLORS.activeRing;
                ctx.lineWidth = 0.9;
                ctx.stroke();
              }

              if (globalScale < LABEL_ZOOM_THRESHOLD) return;

              const fontSize = 10 / globalScale;
              ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillStyle = isActive
                ? GRAPH_COLORS.labelActive
                : node.ghost
                  ? GRAPH_COLORS.ghostStroke
                  : GRAPH_COLORS.label;
              ctx.fillText(node.label, x, y + NODE_RADIUS + 1.5);
            }}
            nodePointerAreaPaint={(
              node: NodeObject<NodeDatum>,
              color: string,
              ctx: CanvasRenderingContext2D,
            ) => {
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(node.x ?? 0, node.y ?? 0, NODE_RADIUS + 3, 0, 2 * Math.PI);
              ctx.fill();
            }}
          />
        )
      )}
    </div>
  );
}
