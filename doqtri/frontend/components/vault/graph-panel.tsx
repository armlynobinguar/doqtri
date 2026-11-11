"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { NodeObject } from "react-force-graph-2d";
import type {
  ForceGraphBridgeProps,
  GraphInstance,
} from "@/components/vault/force-graph-2d";
import { useNodePointer } from "@/components/vault/use-node-pointer";
import { buildGraph, type GraphNode } from "@/lib/wikilinks";
import { GRAPH_COLORS } from "@/lib/theme";
import type { Doc } from "@/lib/types";
import { useNavigate } from "@/components/vault/navigation";

type NodeDatum = GraphNode;
type SimNode = NodeObject<NodeDatum>;

// Touches `window`, so it must never be server-rendered. The bridge carries the
// instance back out (see force-graph-2d.tsx); its generic signature does not
// survive next/dynamic, so it is reapplied here.
const ForceGraph2D = dynamic(() => import("@/components/vault/force-graph-2d"), {
  ssr: false,
}) as unknown as React.ComponentType<ForceGraphBridgeProps<SimNode>>;

const NODE_RADIUS = 3.5;
const LABEL_ZOOM_THRESHOLD = 1.1;
/**
 * The smallest a node's click target may get on screen, in CSS pixels. The dot
 * itself is sized in graph units, so zoomed out it shrinks to a speck that is
 * all but impossible to hit.
 */
const MIN_HIT_RADIUS_PX = 9;

const LABEL_FONT_PX = 10;
const LABEL_OFFSET = NODE_RADIUS + 1.5;
const FONT_STACK = "ui-sans-serif, system-ui, sans-serif";

/** Sets the label font for this zoom; labels keep a constant on-screen size. */
function applyLabelFont(ctx: CanvasRenderingContext2D, globalScale: number) {
  ctx.font = `${LABEL_FONT_PX / globalScale}px ${FONT_STACK}`;
}

const labelWidthCache = new Map<string, number>();
let measureContext: CanvasRenderingContext2D | null | undefined;

/** A label's width in screen pixels, which is the same at every zoom. */
function labelWidthPx(label: string): number {
  const cached = labelWidthCache.get(label);
  if (cached !== undefined) return cached;
  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  let width = label.length * LABEL_FONT_PX * 0.55;
  if (measureContext) {
    measureContext.font = `${LABEL_FONT_PX}px ${FONT_STACK}`;
    width = measureContext.measureText(label).width;
  }
  labelWidthCache.set(label, width);
  return width;
}

/**
 * Whether graph point (px, py) at zoom `k` is on the node: its dot, never
 * smaller than a fingertip on screen, or its label while the label is drawn.
 */
function hitsNode(node: SimNode, px: number, py: number, k: number): boolean {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const radius = Math.max(NODE_RADIUS + 3, MIN_HIT_RADIUS_PX / k);
  if (Math.hypot(px - x, py - y) <= radius) return true;

  if (k < LABEL_ZOOM_THRESHOLD) return false;
  const pad = 2 / k;
  const halfWidth = labelWidthPx(node.label) / k / 2 + pad;
  const top = y + LABEL_OFFSET - pad;
  const bottom = y + LABEL_OFFSET + LABEL_FONT_PX / k + pad;
  return Math.abs(px - x) <= halfWidth && py >= top && py <= bottom;
}

export function GraphPanel({
  docs,
  activeId,
}: {
  docs: Doc[];
  activeId?: string;
}) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<GraphInstance<SimNode> | undefined>(undefined);
  const nodesRef = useRef<SimNode[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // force-graph mutates node objects with simulation coordinates. Rebuilding
  // the graph on every edit would otherwise reset the layout, so positions are
  // cached by node id and seeded back in. The Map itself never changes identity
  // (it is only filled in), so it lives in state rather than a ref: the graph
  // memo reads it during render, which refs must not be.
  const [positions] = useState(() => new Map<string, { x: number; y: number }>());

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

    return {
      nodes: nodes.map((node) => {
        const cached = positions.get(node.id);
        return cached ? { ...node, x: cached.x, y: cached.y } : { ...node };
      }),
      links: edges.map((edge) => ({ source: edge.source, target: edge.target })),
    };
  }, [docs, positions]);

  useEffect(() => {
    nodesRef.current = graphData.nodes;
  }, [graphData]);

  useNodePointer<SimNode>({
    containerRef,
    instanceRef: graphRef,
    getNodes: () => nodesRef.current,
    hitTest: hitsNode,
    // Ghost nodes have no note behind them yet.
    isClickable: (node) => !node.ghost,
    onClick: (node) => navigate(`/vault/${String(node.id)}`),
    onDragEnd: (node) => {
      // Hand the node back to the layout, as force-graph's own drag did.
      node.fx = undefined;
      node.fy = undefined;
      rememberPositions(nodesRef.current);
    },
  });

  function rememberPositions(nodes: SimNode[]) {
    for (const node of nodes) {
      if (typeof node.x === "number" && typeof node.y === "number") {
        positions.set(String(node.id), { x: node.x, y: node.y });
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
            instanceRef={graphRef}
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
            // Hover, click and drag come from useNodePointer, by geometry.
            enablePointerInteraction={false}
            enableNodeDrag={false}
            onEngineStop={() => rememberPositions(graphData.nodes)}
            nodeCanvasObject={(
              node: SimNode,
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

              applyLabelFont(ctx, globalScale);
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.fillStyle = isActive
                ? GRAPH_COLORS.labelActive
                : node.ghost
                  ? GRAPH_COLORS.ghostStroke
                  : GRAPH_COLORS.label;
              ctx.fillText(node.label, x, y + LABEL_OFFSET);
            }}
          />
        )
      )}
    </div>
  );
}
