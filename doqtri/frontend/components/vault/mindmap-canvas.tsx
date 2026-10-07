"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type {
  MindmapForceGraphProps,
  MindmapGraphInstance,
  MindmapGraphNode,
} from "@/components/vault/force-graph-2d";
import { useNodePointer } from "@/components/vault/use-node-pointer";
import { linkIsLit, useMindmapFocus } from "@/components/vault/use-mindmap-focus";
import { FocusLockButton, placeLockButton } from "@/components/vault/focus-lock-button";
import { fontFamily, fontWeight, loadFont } from "@/components/vault/mindmap-fonts";
import {
  canvasToBlob,
  drawLink,
  drawNode,
  linkOffscreen,
  loadWatermarkLogo,
  measureNode,
  fittedBoost,
  isLit,
  labelBoost,
  nodeOffscreen,
  nodeReveal,
  paintBackdrop,
  paintGraphPattern,
  renderSnapshot,
  viewBounds,
  type PaintLink,
  type Painter,
  type ViewBounds,
} from "@/components/vault/mindmap-paint";
import {
  createGravityForce,
  createRadialForce,
  createOverlapResolver,
  isPinned,
  fitBoosts,
  layoutGroups,
  PILL_GAP,
  type BoostItem,
  type Extent,
  separateOnce,
} from "@/lib/mindmap-layout";
import {
  assignBranches,
  DEFAULT_STYLE,
  isHidden,
  particlesPerLink,
  resolveLook,
  type FontKey,
  type MindmapStyle,
  type NodeLook,
} from "@/lib/mindmap-style";
import {
  LARGE_MAP_NODES,
  ZOOM_REVEAL_MIN_NODES,
  type MapNode,
  type MindmapGraph,
} from "@/lib/mindmap-graph";

type GraphNode = MindmapGraphNode;
type GraphInstance = MindmapGraphInstance;

// Touches `window` on import, so it must never be server-rendered. The bridge
// module keeps the typing intact and carries the instance back out — see the
// comment there for why a plain `ref` cannot cross this boundary.
const ForceGraph2D = dynamic(
  () => import("@/components/vault/force-graph-2d"),
  { ssr: false },
) as unknown as React.ComponentType<MindmapForceGraphProps>;

/** How far out the view may zoom, as a share of the zoom that fits the whole map. */
const MIN_ZOOM_OF_FIT = 0.5;

/** How long each frame may spend clearing overlaps once a layout stops. */
const SETTLE_SLICE_MS = 12;

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
  /** A node whose highlight is locked on, if any. */
  lockedId?: string | null;
  /** Lock a node's highlight, or unlock with null. */
  onLockChange?: (id: string | null) => void;
  /** Fired once the first layout has settled and been framed. */
  onSettled?: () => void;
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
  onSettled,
  lockedId = null,
  onLockChange,
}: MindmapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<GraphInstance | undefined>(undefined);
  const [size, setSize] = useState({ width: 0, height: 0 });
  /** The furthest the view may zoom out, set once the map has been framed. */
  const [minZoom, setMinZoom] = useState<number | undefined>(undefined);
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

  /** Node sizes by id for the current painter; cleared whenever it changes. */
  const extentsRef = useRef(new Map<string, Extent>());

  /** Fitted outline-label enlargements for the current frame. */
  const boostsRef = useRef(new Map<string, number>());

  /** The graph-space rectangle on screen, refreshed every frame for culling. */
  const viewRef = useRef<ViewBounds | null>(null);

  const large = graph.nodes.length > LARGE_MAP_NODES;

  const lookup = useLookup(graph, look);
  const loadedFont = useLoadedFont(look.font);

  // Focus redraws through force-graph's zoom trigger (see requestRedraw); the
  // instance is only known later, so this reads it from the ref at call time.
  const focus = useMindmapFocus(
    graph,
    look.focus && !editing,
    () => {
      const instance = graphRef.current;
      if (instance) instance.zoom(instance.zoom());
    },
    lockedId,
  );
  const lockButtonRef = useRef<HTMLButtonElement>(null);
  /** Live nodes by id, for placing the lock beside the focused one. */
  const nodeIndexRef = useRef(new Map<string, GraphNode>());

  const painter = useMemo<Painter>(
    () => ({
      style: look,
      family: fontFamily(loadedFont),
      weight: fontWeight(loadedFont),
      look: lookup,
      selectedId,
      large,
      focus: focus.stateRef,
      reveal: look.zoomReveal && graph.nodes.length >= ZOOM_REVEAL_MIN_NODES,
      boosts: boostsRef,
      dpr: typeof window === "undefined" ? 1 : window.devicePixelRatio,
    }),
    [look, loadedFont, lookup, selectedId, large, focus.stateRef, graph.nodes.length],
  );
  const painterRef = useRef(painter);
  useEffect(() => {
    painterRef.current = painter;
    extentsRef.current = new Map();
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
  // Each connected group of the map gets its own radial tree and its own
  // patch of the canvas (see layoutGroups): branches start beside their
  // parents, and groups that share nothing never start on top of each other.
  const places = useMemo(() => layoutGroups(graph.nodes, graph.links, RING_DISTANCE), [graph]);

  const graphData = useMemo(
    () => ({
      nodes: graph.nodes.map((node) => {
        const place = places.get(node.id);
        return place ? { ...node, x: place.x, y: place.y } : { ...node };
      }),
      links: graph.links.map((link) => ({ ...link })),
    }),
    [graph, places],
  );

  /** How many links touch each node: the bigger hubs win label collisions. */
  const degree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { source, target } of graph.links) {
      counts.set(source, (counts.get(source) ?? 0) + 1);
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    return counts;
  }, [graph]);

  /*
   * The overlap passes ask for every node's size many times per tick. Measuring
   * builds a cache key from the font, shape and label each time, which at a
   * thousand nodes is most of the tick — so sizes are kept by node id here and
   * only re-measured when the painter changes.
   */
  const extentOf = useCallback((node: GraphNode) => {
    const cache = extentsRef.current;
    let extent = cache.get(node.id);
    if (!extent) {
      extent = measureNode(painterRef.current, node);
      cache.set(node.id, extent);
    }
    return extent;
  }, []);
  const visibleNodes = useCallback(
    () => nodesRef.current.filter((node) => !isHidden(painterRef.current.style, node.id)),
    [],
  );

  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  });

  /** The animation frame of an in-progress settle, so a new one replaces it. */
  const settleFrameRef = useRef(0);
  useEffect(() => () => cancelAnimationFrame(settleFrameRef.current), []);

  /**
   * Clears every remaining overlap, a frame-sized slice at a time, then calls
   * `done`. On a big map the full clean-up is most of a second of work; run as
   * one call it froze the page right as the map finished building.
   */
  const settle = useCallback(
    (done: () => void) => {
      cancelAnimationFrame(settleFrameRef.current);
      const step = createOverlapResolver(visibleNodes(), extentOf);
      const run = () => {
        if (step(SETTLE_SLICE_MS)) done();
        else settleFrameRef.current = requestAnimationFrame(run);
      };
      run();
    },
    [visibleNodes, extentOf],
  );

  /**
   * Asks force-graph for one more frame. Once its engine has stopped it only
   * redraws on its own triggers, and setting the zoom — even to the same
   * value — is one of them.
   */
  const requestRedraw = useCallback(() => {
    const instance = graphRef.current;
    if (instance) instance.zoom(instance.zoom());
  }, []);

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
      // Both pull toward each node's own group, not one shared centre, so the
      // groups the layout started apart stay apart. Group centres spread with
      // the spacing, as the groups themselves do.
      const placeOf = (node: GraphNode) => places.get(node.id);
      instance.d3Force(
        "gravity",
        layout !== "radial"
          ? createGravityForce<GraphNode>(0.12, (node) => {
              const place = placeOf(node);
              return place ? { x: place.centreX * spacing, y: place.centreY * spacing } : { x: 0, y: 0 };
            })
          : null,
      );
      instance.d3Force(
        "radial",
        layout === "radial"
          ? createRadialForce<GraphNode>(RING_DISTANCE * spacing, (node) => {
              const place = placeOf(node);
              return place
                ? { ring: place.ring, x: place.centreX * spacing, y: place.centreY * spacing }
                : { ring: node.depth, x: 0, y: 0 };
            })
          : null,
      );

      framedRef.current = false;
      instance.d3ReheatSimulation();
    },
    [layout, spacing, extentOf, places],
  );

  useEffect(() => {
    nodesRef.current = graphData.nodes as GraphNode[];
    nodeIndexRef.current = new Map(nodesRef.current.map((node) => [node.id, node]));
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
    hitTest: (node, x, y, k) => {
      // A level the zoom has not revealed yet cannot be pointed at either.
      if (nodeReveal(painterRef.current, node, k) < 0.5) return false;
      // An enlarged outline node is hit where it is drawn, not where it lays out.
      const boost = fittedBoost(painterRef.current, node, k);
      const { halfWidth, halfHeight } = extentOf(node);
      return (
        Math.abs(x - (node.x ?? 0)) <= halfWidth * boost && Math.abs(y - (node.y ?? 0)) <= halfHeight * boost
      );
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
    onHover: (node) => focus.hover(node?.id ?? null),
    // Only while focus is on: otherwise a hold would swallow the tap that
    // selects a node in edit mode.
    onLongPress: look.focus && !editing ? (node) => focus.hold(node.id) : undefined,
    onPressEmpty: focus.clear,
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
        // Exports are the map as styled, never dimmed by a stray hover.
        const canvas = renderSnapshot(nodesRef.current, linksRef.current, { ...painterRef.current, focus: undefined, reveal: false }, {
          width: request.width,
          height: request.height,
          title: request.title,
          watermark: request.watermark,
          logo: request.watermark ? await loadWatermarkLogo(painterRef.current.style) : null,
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
      className="relative min-h-0 flex-1 overflow-hidden select-none [-webkit-touch-callout:none]"
      style={{ backgroundColor: look.palette.background }}
    >
      <FocusLockButton
        buttonRef={lockButtonRef}
        onPointerEnter={() => focus.hover(focus.stateRef.current.id)}
        onToggle={() => {
          const id = focus.stateRef.current.id;
          if (id) onLockChange?.(lockedId === id ? null : id);
        }}
      />

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
          // A big map cools faster: it has more to settle, but every tick costs
          // more, and the overlap pass cleans up what the forces leave.
          minZoom={minZoom}
          cooldownTicks={large ? 120 : 200}
          d3AlphaDecay={large ? 0.04 : 0.022}
          d3VelocityDecay={0.35}
          nodeVisibility={(node: GraphNode) => !isHidden(look, node.id)}
          linkVisibility={(link: PaintLink) =>
            typeof link.source !== "object" ||
            typeof link.target !== "object" ||
            !(isHidden(look, link.source.id) || isHidden(look, link.target.id))
          }
          linkCurvature={look.link.curvature}
          linkCanvasObjectMode={() => "replace"}
          linkCanvasObject={(link: PaintLink, ctx: CanvasRenderingContext2D) => {
            const view = viewRef.current;
            if (view && linkOffscreen(view, link, look.link.curvature)) return;
            drawLink(ctx, link, painter);
          }}
          linkDirectionalParticles={particlesPerLink(look, graph.links.length)}
          linkDirectionalParticleSpeed={look.link.particleSpeed}
          linkDirectionalParticleWidth={look.link.particleSize}
          // Drawn here rather than by force-graph so a focus can skip the
          // dimmed links' particles entirely instead of fading them.
          linkDirectionalParticleCanvasObject={(
            x: number,
            y: number,
            link: PaintLink,
            ctx: CanvasRenderingContext2D,
            globalScale: number,
          ) => {
            const { source, target } = link;
            if (typeof source !== "object" || typeof target !== "object") return;
            if (!linkIsLit(focus.stateRef.current, source.id, target.id)) return;
            const painterNow = painterRef.current;
            if (
              nodeReveal(painterNow, source, globalScale) < 0.5 ||
              nodeReveal(painterNow, target, globalScale) < 0.5
            ) {
              return;
            }
            ctx.fillStyle = lookup(target).accent;
            ctx.beginPath();
            ctx.arc(x, y, look.link.particleSize / 2 / Math.sqrt(globalScale), 0, Math.PI * 2);
            ctx.fill();
          }}
          onRenderFramePost={() => {
            // Keep the lock beside the focused node, which may be moving.
            const state = focus.stateRef.current;
            const instance = graphRef.current;
            const node = state.id ? nodeIndexRef.current.get(state.id) : undefined;
            let at: { x: number; y: number } | null = null;
            if (node && state.set && state.t > 0.5 && instance && !isHidden(look, node.id)) {
              const halfWidth = extentOf(node).halfWidth * fittedBoost(painter, node, instance.zoom());
              const point = instance.graph2ScreenCoords((node.x ?? 0) + halfWidth, node.y ?? 0);
              // Overlapping the pill's edge, so the pointer never crosses a gap
              // of empty canvas — which would read as leaving the node.
              at = { x: point.x - 6, y: point.y - 12 };
            }
            placeLockButton(lockButtonRef.current, at, state.id !== null && state.id === lockedId);
          }}
          // Hover, click and drag come from useNodePointer, by geometry.
          enablePointerInteraction={false}
          enableNodeDrag={false}
          onRenderFramePre={(ctx: CanvasRenderingContext2D) => {
            const { width, height } = ctx.canvas;
            paintBackdrop(ctx, width, height, painterRef.current.style);
            paintGraphPattern(ctx, width, height, painterRef.current.style);
            viewRef.current = viewBounds(ctx, 20);

            // Outline labels drawn enlarged must not run into each other: fit
            // each one's enlargement to the room around it, for this zoom.
            const painterNow = painterRef.current;
            const zoom = graphRef.current?.zoom();
            if (painterNow.reveal && zoom) {
              const items: BoostItem[] = [];
              for (const node of nodesRef.current) {
                const lit = isLit(painterNow, node);
                if ((node.depth > 1 && !lit) || isHidden(painterNow.style, node.id)) continue;
                const { halfWidth, halfHeight } = extentOf(node);
                items.push({
                  id: node.id,
                  x: node.x ?? 0,
                  y: node.y ?? 0,
                  halfWidth,
                  halfHeight,
                  want: labelBoost(painterNow, node, zoom),
                  // The locked node, then its highlighted branch, then roots,
                  // then the most connected: a highlight keeps its size and
                  // the dimmed labels around it give way.
                  priority:
                    (node.id === lockedId ? 1_000_000 : 0) +
                    (lit ? 100_000 : 0) +
                    (node.depth === 0 ? 10_000 : 0) +
                    (degree.get(node.id) ?? 0),
                });
              }
              boostsRef.current = fitBoosts(items, PILL_GAP);
            }
            // Fonts, emoji and sizes change what a node occupies; clear any
            // overlap that opened up before it is drawn. Only on a settled map:
            // while the layout runs, the per-tick pass handles it, and a full
            // resolve over the starting pile would stall the page.
            if (resizedRef.current && framedRef.current) {
              resizedRef.current = false;
              settle(requestRedraw);
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
            settle(() => {
              if (framedRef.current) {
                requestRedraw();
                return;
              }
              framedRef.current = true;
              resizedRef.current = false;
              graphRef.current?.zoomToFit(400, 40);
              onSettledRef.current?.();
              // Once framed, stop zooming out far past the whole map — there is
              // nothing out there, and it only shrinks the map to a speck.
              // Read after the framing animation has landed.
              setTimeout(() => {
                const zoom = graphRef.current?.zoom();
                if (zoom) setMinZoom(zoom * MIN_ZOOM_OF_FIT);
              }, 450);
            });
          }}
          nodeCanvasObject={(node: GraphNode, ctx: CanvasRenderingContext2D) => {
            const view = viewRef.current;
            if (view && nodeOffscreen(view, node, extentOf(node))) return;
            drawNode(ctx, node, painter);
          }}
        />
      )}
    </div>
  );
}
