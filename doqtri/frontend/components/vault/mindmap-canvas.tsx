"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type {
  MindmapGraphInstance,
  MindmapGraphNode,
} from "@/components/vault/force-graph-2d";
import { MINDMAP_COLORS } from "@/lib/theme";
import {
  createGravityForce,
  isPinned,
  resolveOverlaps,
  separateOnce,
  type Extent,
} from "@/lib/mindmap-layout";
import type { MapNode, MapNodeKind, MindmapGraph } from "@/lib/mindmap-graph";

type GraphNode = MindmapGraphNode;
type GraphInstance = MindmapGraphInstance;

// Touches `window` on import, so it must never be server-rendered. The bridge
// module keeps the typing intact and carries the instance back out — see the
// comment there for why a plain `ref` cannot cross this boundary.
const ForceGraph2D = dynamic(
  () => import("@/components/vault/force-graph-2d"),
  { ssr: false },
);

/**
 * Pill geometry per node kind, in graph units.
 *
 * The canvas draws labelled pills rather than dots: a mindmap is unreadable if
 * you have to zoom in far enough for the labels to appear, which is the
 * tradeoff the vault graph makes and this view cannot.
 */
const PILL: Record<MapNodeKind, { font: number; padX: number; padY: number }> = {
  root: { font: 7, padX: 7, padY: 4.5 },
  document: { font: 6, padX: 6, padY: 4 },
  hub: { font: 5.5, padX: 5.5, padY: 3.5 },
  theme: { font: 5.5, padX: 5.5, padY: 3.5 },
  concept: { font: 4.5, padX: 4.5, padY: 3 },
  detail: { font: 4, padX: 4, padY: 2.5 },
};

const FONT_STACK = "ui-sans-serif, system-ui, sans-serif";

const extentCache = new Map<string, Extent>();
let measureContext: CanvasRenderingContext2D | null | undefined;

/**
 * Measures a pill once and caches it by kind and label.
 *
 * Measurement happens on a detached canvas rather than inside the paint
 * callback, because the collision force needs pill sizes before the first
 * frame is ever drawn. Same font, same metrics — and one cache means the
 * layout, the hit area, and the drawing can never disagree about a pill's size.
 */
function measureExtent(kind: MapNodeKind, label: string): Extent {
  const key = `${kind}|${label}`;
  const cached = extentCache.get(key);
  if (cached) return cached;

  const style = PILL[kind] ?? PILL.concept;

  if (measureContext === undefined) {
    measureContext =
      typeof document === "undefined"
        ? null
        : document.createElement("canvas").getContext("2d");
  }

  let textWidth: number;
  if (measureContext) {
    measureContext.font = `${style.font}px ${FONT_STACK}`;
    textWidth = measureContext.measureText(label).width;
  } else {
    // Server render or a context-less browser: a rough estimate is fine, since
    // nothing is visible yet and the real measurement lands on first paint.
    textWidth = label.length * style.font * 0.55;
  }

  const extent: Extent = {
    halfWidth: textWidth / 2 + style.padX,
    halfHeight: style.font / 2 + style.padY,
  };
  extentCache.set(key, extent);
  return extent;
}

function extentOf(node: GraphNode): Extent {
  return measureExtent(node.kind, node.label);
}

export function MindmapCanvas({
  graph,
  onNodeClick,
  emptyMessage = "Nothing to map yet.",
  layout = "radial",
}: {
  graph: MindmapGraph;
  onNodeClick?: (node: MapNode) => void;
  emptyMessage?: string;
  /**
   * `radial` rings a single tree outward from its root. `free` is an
   * unconstrained force layout, which is what the vault-wide map wants: it is a
   * forest with several roots, and rings would just stack them.
   */
  layout?: "radial" | "free";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<GraphInstance | undefined>(undefined);
  const [size, setSize] = useState({ width: 0, height: 0 });

  /**
   * The live node objects, which the simulation mutates in place and which the
   * layout callbacks below mutate too. Held in a ref rather than read straight
   * off the memo: a value produced during render is not ours to write to.
   */
  const nodesRef = useRef<GraphNode[]>([]);

  /** Whether this graph has been framed yet, so a drag cannot re-frame it. */
  const framedRef = useRef(false);

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

  // force-graph mutates the objects it is given with simulation state, so it
  // gets copies. Rebuilding also resets the layout, which is correct here:
  // a different graph is a different map.
  const graphData = useMemo(
    () => ({
      nodes: graph.nodes.map((node) => ({ ...node })),
      links: graph.links.map((link) => ({ ...link })),
    }),
    [graph],
  );

  /**
   * Widens the default forces to suit pills.
   *
   * d3's defaults are tuned for dots: repulsion of -30 and a link distance of
   * 30 assume a node is a few pixels across, so pills the width of a phrase
   * start out on top of each other and the collision pass spends the whole
   * simulation digging them apart. Giving the springs room up front does most
   * of the work, and the link distance accounts for how wide the two endpoints
   * actually are.
   */
  const applyForces = useCallback(
    (instance: GraphInstance) => {
      instance.d3Force("charge")?.strength(-300).distanceMax(500);

      instance
        .d3Force("link")
        ?.distance((link: { source: GraphNode; target: GraphNode }) => {
          // d3 replaces the endpoint ids with node objects once it initializes.
          const from = typeof link.source === "object" ? link.source : undefined;
          const to = typeof link.target === "object" ? link.target : undefined;
          const span =
            (from ? extentOf(from).halfWidth : 0) +
            (to ? extentOf(to).halfWidth : 0);
          return 46 + span;
        });

      // Only the free layout needs it: the radial mode already holds every node
      // at a fixed distance from the centre.
      instance.d3Force(
        "gravity",
        layout === "free" ? createGravityForce<GraphNode>(0.12) : null,
      );

      instance.d3ReheatSimulation();
    },
    [layout],
  );

  useEffect(() => {
    nodesRef.current = graphData.nodes as GraphNode[];
    framedRef.current = false;

    // Null on the first pass: the graph is behind a dynamic import, so it
    // mounts a tick later than this component and reports in via `onReady`.
    const instance = graphRef.current;
    if (instance) applyForces(instance);
  }, [graphData, applyForces]);

  const releaseAll = useCallback(() => {
    for (const node of nodesRef.current) {
      /*
       * force-graph owns these objects once they are handed over — it writes
       * simulation state onto them every tick, and clearing `fx`/`fy` is the
       * documented way to hand a fixed node back to the layout. The compiler
       * traces them to the memo that made the copies and calls them frozen;
       * here it is wrong about who owns them.
       */
      // eslint-disable-next-line react-hooks/immutability
      node.fx = undefined;
      // eslint-disable-next-line react-hooks/immutability
      node.fy = undefined;
    }
    framedRef.current = false;
    graphRef.current?.d3ReheatSimulation();
  }, []);

  if (graph.nodes.length === 0) {
    return (
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <p className="text-label absolute inset-0 flex items-center justify-center px-4 text-center text-[12px]">
          {emptyMessage}
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
      {/*
        Always available rather than shown once something is pinned: knowing the
        arrangement can be undone is what makes dragging safe to try, and
        counting pinned nodes would mean reading simulation state during render.
      */}
      <button
        type="button"
        onClick={releaseAll}
        title="Release every node back into the layout"
        className="border-border/80 bg-muted/90 text-muted-foreground hover:text-foreground hover:border-border absolute top-2 right-2 z-10 rounded-md border px-2 py-1 text-[11px] backdrop-blur transition-colors"
      >
        Reset layout
      </button>

      {size.width > 0 && (
        <ForceGraph2D
          instanceRef={graphRef}
          onReady={applyForces}
          width={size.width}
          height={size.height}
          graphData={graphData}
          backgroundColor={MINDMAP_COLORS.background}
          // Rings outward from the root for a single tree. The vault-wide map
          // passes `free`, where a radial force would fight both the several
          // roots it has and the nodes the user has moved.
          dagMode={layout === "radial" ? "radialout" : undefined}
          dagLevelDistance={layout === "radial" ? 70 : undefined}
          // A shared concept in the global view has two parents, which is still
          // a DAG. A genuine cycle should degrade to a force layout, not throw.
          onDagError={() => {}}
          cooldownTicks={200}
          d3AlphaDecay={0.022}
          d3VelocityDecay={0.35}
          linkColor={() => MINDMAP_COLORS.link}
          linkWidth={1}
          enableNodeDrag
          nodeLabel={(node: GraphNode) =>
            node.summary ?? (isPinned(node) ? "Right-click to release" : "")
          }
          showPointerCursor={(node) => Boolean(node)}
          onNodeClick={(node: GraphNode) => onNodeClick?.(node as MapNode)}
          /*
           * Pins the node where it was dropped. force-graph's own default is to
           * hand the node straight back to the simulation, which reads as the
           * drag having been ignored — and under a radial layout the node is
           * visibly yanked back onto its ring. A deliberate move should stick.
           */
          onNodeDragEnd={(node: GraphNode) => {
            node.fx = node.x;
            node.fy = node.y;
          }}
          onNodeRightClick={(node: GraphNode, event: MouseEvent) => {
            event.preventDefault();
            if (!isPinned(node)) return;
            node.fx = undefined;
            node.fy = undefined;
            graphRef.current?.d3ReheatSimulation();
          }}
          // Runs after d3 has integrated the tick, so the separation it applies
          // is what the frame actually draws. The last tick before the engine
          // stops therefore leaves the map with no pills overlapping.
          onEngineTick={() => {
            separateOnce(nodesRef.current, extentOf, 0.5);
          }}
          onEngineStop={() => {
            // The engine has stopped, so nothing will integrate away a residual
            // overlap. Resolve what is left outright, then frame the result.
            resolveOverlaps(nodesRef.current, extentOf);
            if (!framedRef.current) {
              framedRef.current = true;
              graphRef.current?.zoomToFit(400, 40);
            }
          }}
          nodeCanvasObject={(node: GraphNode, ctx: CanvasRenderingContext2D) => {
            const style = PILL[node.kind] ?? PILL.concept;
            const colors = MINDMAP_COLORS[node.kind] ?? MINDMAP_COLORS.concept;
            const { halfWidth, halfHeight } = extentOf(node);
            const x = node.x ?? 0;
            const y = node.y ?? 0;

            ctx.beginPath();
            ctx.roundRect(
              x - halfWidth,
              y - halfHeight,
              halfWidth * 2,
              halfHeight * 2,
              halfHeight,
            );
            ctx.fillStyle = colors.fill;
            ctx.fill();
            // A hand-placed node reads as deliberate, so its outline is firmer.
            ctx.strokeStyle = colors.stroke;
            ctx.lineWidth = isPinned(node) ? 1.1 : 0.5;
            ctx.stroke();

            ctx.font = `${style.font}px ${FONT_STACK}`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillStyle = colors.text;
            ctx.fillText(node.label, x, y);
          }}
          nodePointerAreaPaint={(
            node: GraphNode,
            color: string,
            ctx: CanvasRenderingContext2D,
          ) => {
            const { halfWidth, halfHeight } = extentOf(node);
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.roundRect(
              (node.x ?? 0) - halfWidth,
              (node.y ?? 0) - halfHeight,
              halfWidth * 2,
              halfHeight * 2,
              halfHeight,
            );
            ctx.fill();
          }}
        />
      )}
    </div>
  );
}
