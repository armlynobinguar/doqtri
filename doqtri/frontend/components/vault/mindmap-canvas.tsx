"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type {
  MindmapForceGraphProps,
  MindmapGraphInstance,
  MindmapGraphNode,
} from "@/components/vault/force-graph-2d";
import { useNodePointer } from "@/components/vault/use-node-pointer";
import { fontFamily, fontWeight, loadFont } from "@/components/vault/mindmap-fonts";
import {
  canvasToBlob,
  drawLink,
  drawNode,
  measureNode,
  paintBackdrop,
  paintGraphPattern,
  renderSnapshot,
  type PaintLink,
  type Painter,
} from "@/components/vault/mindmap-paint";
import {
  createGravityForce,
  createRadialForce,
  isPinned,
  resolveOverlaps,
  separateOnce,
} from "@/lib/mindmap-layout";
import {
  assignBranches,
  DEFAULT_STYLE,
  isHidden,
  resolveLook,
  type FontKey,
  type MindmapStyle,
  type NodeLook,
} from "@/lib/mindmap-style";
import type { MapNode, MindmapGraph } from "@/lib/mindmap-graph";

type GraphNode = MindmapGraphNode;
type GraphInstance = MindmapGraphInstance;

// Touches `window` on import, so it must never be server-rendered. The bridge
// module keeps the typing intact and carries the instance back out — see the
// comment there for why a plain `ref` cannot cross this boundary.
const ForceGraph2D = dynamic(
  () => import("@/components/vault/force-graph-2d"),
  { ssr: false },
) as unknown as React.ComponentType<MindmapForceGraphProps>;

/** Spacing between the rings of the radial layout, in graph units. */
const RING_DISTANCE = 70;

export type SnapshotRequest = {
  width: number;
  height: number;
  /** Frame the whole map rather than what is on screen. */
  fit: boolean;
  title?: string;
  watermark: boolean;
};

/** What the studio can ask of either renderer. */
export type MindmapCanvasHandle = {
  releaseAll: () => void;
  snapshot: (request: SnapshotRequest) => Promise<Blob>;
  /** The on-screen size, in CSS pixels, for "match the view" exports. */
  viewSize: () => { width: number; height: number };
};

export type MindmapCanvasProps = {
  graph: MindmapGraph;
  onNodeClick?: (node: MapNode) => void;
  /**
   * Which nodes a click does something for, so only those get the hand cursor.
   * Defaults to every node when there is a click handler at all.
   */
  isClickable?: (node: MapNode) => boolean;
  emptyMessage?: string;
  /** How the map looks, layout included. */
  look?: MindmapStyle;
  /** In edit mode a click selects the node instead of following it. */
  editing?: boolean;
  selectedId?: string | null;
  onSelect?: (node: MapNode) => void;
  handleRef?: React.Ref<MindmapCanvasHandle>;
};

/**
 * Colour lookup for one style over one graph.
 *
 * Every frame asks for every node's colours, often twice (the node and its
 * links), and resolving them mixes several colours — so they are worked out
 * once per style change rather than per frame.
 */
export function useLookup(graph: MindmapGraph, look: MindmapStyle) {
  const branches = useMemo(() => assignBranches(graph), [graph]);
  return useMemo(() => {
    const looks = new Map<string, NodeLook>(
      graph.nodes.map((node) => [
        node.id,
        resolveLook(look, node, branches.branch.get(node.id) ?? 0, branches.maxDepth),
      ]),
    );
    return (node: MapNode): NodeLook =>
      looks.get(node.id) ?? resolveLook(look, node, 0, branches.maxDepth);
  }, [graph, look, branches]);
}

/** The font a style asks for, once it has actually loaded. */
export function useLoadedFont(key: FontKey): FontKey {
  const [loaded, setLoaded] = useState<FontKey>("sans");
  useEffect(() => {
    let cancelled = false;
    void loadFont(key).then(() => {
      if (!cancelled) setLoaded(key);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return loaded;
}

export function MindmapCanvas({
  graph,
  onNodeClick,
  isClickable = () => onNodeClick !== undefined,
  emptyMessage = "Nothing to map yet.",
  look = DEFAULT_STYLE,
  editing = false,
  selectedId = null,
  onSelect,
  handleRef,
}: MindmapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<GraphInstance | undefined>(undefined);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const layout = look.layout;

  /**
   * The live node objects, which the simulation mutates in place and which the
   * layout callbacks below mutate too. Held in a ref rather than read straight
   * off the memo: a value produced during render is not ours to write to.
   */
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<PaintLink[]>([]);

  /** Whether this graph has been framed yet, so a drag cannot re-frame it. */
  const framedRef = useRef(false);

  /** Set when node sizes change, so the next frame clears any new overlap. */
  const resizedRef = useRef(false);

  const lookup = useLookup(graph, look);
  const loadedFont = useLoadedFont(look.font);

  const painter = useMemo<Painter>(
    () => ({
      style: look,
      family: fontFamily(loadedFont),
      weight: fontWeight(loadedFont),
      look: lookup,
      selectedId,
    }),
    [look, loadedFont, lookup, selectedId],
  );
  const painterRef = useRef(painter);
  useEffect(() => {
    painterRef.current = painter;
    resizedRef.current = true;
  }, [painter]);

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

  const extentOf = useCallback((node: GraphNode) => measureNode(painterRef.current, node), []);
  const visibleNodes = useCallback(
    () => nodesRef.current.filter((node) => !isHidden(painterRef.current.style, node.id)),
    [],
  );

  const spacing = look.spacing;

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
      instance.d3Force("charge")?.strength(-300 * spacing).distanceMax(500 * spacing);

      instance
        .d3Force("link")
        ?.distance((link: { source: GraphNode; target: GraphNode }) => {
          // d3 replaces the endpoint ids with node objects once it initializes.
          const from = typeof link.source === "object" ? link.source : undefined;
          const to = typeof link.target === "object" ? link.target : undefined;
          const span =
            (from ? extentOf(from).halfWidth : 0) +
            (to ? extentOf(to).halfWidth : 0);
          return 46 * spacing + span;
        });

      // Gravity keeps the free layout's disconnected clusters from drifting
      // apart, and keeps the tree layouts' cross axis together; the radial
      // mode already holds every node at a fixed distance from the centre.
      instance.d3Force(
        "gravity",
        layout !== "radial" ? createGravityForce<GraphNode>(0.12) : null,
      );
      instance.d3Force(
        "radial",
        layout === "radial"
          ? createRadialForce<GraphNode>(RING_DISTANCE * spacing)
          : null,
      );

      framedRef.current = false;
      instance.d3ReheatSimulation();
    },
    [layout, spacing, extentOf],
  );

  useEffect(() => {
    nodesRef.current = graphData.nodes as GraphNode[];
    linksRef.current = graphData.links as PaintLink[];
    framedRef.current = false;

    // Null on the first pass: the graph is behind a dynamic import, so it
    // mounts a tick later than this component and reports in via `onReady`.
    const instance = graphRef.current;
    if (instance) applyForces(instance);
  }, [graphData, applyForces]);

  useNodePointer<GraphNode>({
    containerRef,
    instanceRef: graphRef,
    getNodes: visibleNodes,
    hitTest: (node, x, y) => {
      const { halfWidth, halfHeight } = extentOf(node);
      return Math.abs(x - (node.x ?? 0)) <= halfWidth && Math.abs(y - (node.y ?? 0)) <= halfHeight;
    },
    isClickable: (node) =>
      editing ? onSelect !== undefined : onNodeClick !== undefined && isClickable(node as MapNode),
    onClick: (node) => (editing ? onSelect?.(node as MapNode) : onNodeClick?.(node as MapNode)),
    /*
     * Pins the node where it was dropped — fx/fy already hold the drop point.
     * Handing it straight back to the simulation reads as the drag having been
     * ignored, and under a radial layout the node is visibly yanked back onto
     * its ring. A deliberate move should stick.
     */
    onDragEnd: () => {},
    onRightClick: (node) => {
      if (!isPinned(node)) return;
      node.fx = undefined;
      node.fy = undefined;
      graphRef.current?.d3ReheatSimulation();
    },
    tooltip: (node) =>
      editing
        ? "Click to style this node"
        : (node.summary ?? (isPinned(node) ? "Right-click to release" : undefined)),
  });

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
      node.fy = undefined;
    }
    framedRef.current = false;
    graphRef.current?.d3ReheatSimulation();
  }, []);

  useImperativeHandle(
    handleRef,
    () => ({
      releaseAll,
      viewSize: () => size,
      snapshot: async (request) => {
        const instance = graphRef.current;
        const center = instance?.centerAt() as unknown as { x: number; y: number } | undefined;
        const canvas = renderSnapshot(nodesRef.current, linksRef.current, painterRef.current, {
          width: request.width,
          height: request.height,
          title: request.title,
          watermark: request.watermark,
          frame:
            request.fit || !instance || !center
              ? { kind: "fit" }
              : {
                  kind: "view",
                  centerX: center.x,
                  centerY: center.y,
                  zoom: instance.zoom(),
                  viewWidth: size.width,
                  viewHeight: size.height,
                },
        });
        return canvasToBlob(canvas);
      },
    }),
    [releaseAll, size],
  );

  // One container either way: the resize observer and pointer listeners attach
  // to it once, at mount, so it must exist even while there is nothing to map.
  if (graph.nodes.length === 0) {
    return (
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
        <p className="text-label absolute inset-0 flex items-center justify-center px-4 text-center text-[12px]">
          {emptyMessage}
        </p>
      </div>
    );
  }

  const dagMode = layout === "tree-down" ? "td" : layout === "tree-right" ? "lr" : undefined;

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 flex-1 overflow-hidden"
      style={{ backgroundColor: look.palette.background }}
    >
      {size.width > 0 && (
        <ForceGraph2D
          instanceRef={graphRef}
          onReady={applyForces}
          width={size.width}
          height={size.height}
          graphData={graphData}
          // No dagMode for the radial layout: its rings shake the map (see
          // createRadialForce), so they come from the force set in applyForces.
          dagMode={dagMode}
          dagLevelDistance={60 * spacing}
          // A merged concept can close a loop in the global map; the tree
          // layouts then just place what they can instead of throwing.
          onDagError={() => {}}
          cooldownTicks={200}
          d3AlphaDecay={0.022}
          d3VelocityDecay={0.35}
          nodeVisibility={(node: GraphNode) => !isHidden(look, node.id)}
          linkVisibility={(link: PaintLink) =>
            typeof link.source !== "object" ||
            typeof link.target !== "object" ||
            !(isHidden(look, link.source.id) || isHidden(look, link.target.id))
          }
          linkCurvature={look.link.curvature}
          linkCanvasObjectMode={() => "replace"}
          linkCanvasObject={(link: PaintLink, ctx: CanvasRenderingContext2D) => drawLink(ctx, link, painter)}
          linkDirectionalParticles={look.link.particles}
          linkDirectionalParticleSpeed={look.link.particleSpeed}
          linkDirectionalParticleWidth={look.link.particleSize}
          linkDirectionalParticleColor={(link: PaintLink) =>
            typeof link.target === "object" ? lookup(link.target).accent : look.palette.link
          }
          // Hover, click and drag come from useNodePointer, by geometry.
          enablePointerInteraction={false}
          enableNodeDrag={false}
          onRenderFramePre={(ctx: CanvasRenderingContext2D) => {
            const { width, height } = ctx.canvas;
            paintBackdrop(ctx, width, height, painterRef.current.style);
            paintGraphPattern(ctx, width, height, painterRef.current.style);
            if (resizedRef.current) {
              // Fonts, emoji and sizes change what a node occupies; clear any
              // overlap that opened up before it is drawn.
              resizedRef.current = false;
              resolveOverlaps(visibleNodes(), extentOf);
            }
          }}
          // Runs after d3 has integrated the tick, so the separation it applies
          // is what the frame actually draws. The last tick before the engine
          // stops therefore leaves the map with no pills overlapping.
          onEngineTick={() => {
            separateOnce(visibleNodes(), extentOf, 0.5);
          }}
          onEngineStop={() => {
            // The engine has stopped, so nothing will integrate away a residual
            // overlap. Resolve what is left outright, then frame the result.
            resolveOverlaps(visibleNodes(), extentOf);
            if (!framedRef.current) {
              framedRef.current = true;
              graphRef.current?.zoomToFit(400, 40);
            }
          }}
          nodeCanvasObject={(node: GraphNode, ctx: CanvasRenderingContext2D) => drawNode(ctx, node, painter)}
        />
      )}
    </div>
  );
}
