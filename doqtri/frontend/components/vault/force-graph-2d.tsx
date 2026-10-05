"use client";

import { useEffect, useRef } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type {
  ForceGraphMethods,
  ForceGraphProps,
  NodeObject,
} from "react-force-graph-2d";
import type { MapNode } from "@/lib/mindmap-graph";

export type LinkDatum = Record<string, unknown>;
export type GraphInstance<N> = ForceGraphMethods<N, LinkDatum>;

export type ForceGraphBridgeProps<N> = ForceGraphProps<N, LinkDatum> & {
  /** Receives the graph instance, for imperative access to the d3 forces. */
  instanceRef: React.RefObject<GraphInstance<N> | undefined>;
  /** Fired once the instance exists, which is later than the parent's mount. */
  onReady?: (instance: GraphInstance<N>) => void;
};

export type MindmapNodeDatum = MapNode;
export type MindmapLinkDatum = LinkDatum;
export type MindmapGraphNode = NodeObject<MindmapNodeDatum>;
export type MindmapGraphInstance = GraphInstance<MindmapNodeDatum>;
export type MindmapForceGraphProps = ForceGraphBridgeProps<MindmapNodeDatum>;

/**
 * Thin bridge to `react-force-graph-2d`.
 *
 * Exists for one reason: the graph must be loaded through `next/dynamic` with
 * `ssr: false` because it touches `window` on import, and a `ref` does not
 * survive that boundary — `next/dynamic` wraps the component in `React.lazy`,
 * which leaves the ref unattached, so the instance is never handed back.
 *
 * Passing the ref object as an ordinary prop sidesteps React's ref handling
 * entirely; this module is what turns it back into a real `ref`, on the browser
 * side of the boundary. Without it, the layout forces in mindmap-canvas.tsx
 * silently never apply, and neither canvas can hit-test its nodes.
 *
 * `onReady` matters just as much. The dynamic import suspends, so this
 * component mounts a full tick after its parent — any effect the parent runs at
 * its own mount still sees an empty ref. This fires from inside the boundary,
 * once the instance genuinely exists.
 */
export default function ForceGraphBridge<N>({
  instanceRef,
  onReady,
  ...props
}: ForceGraphBridgeProps<N>) {
  const localRef = useRef<GraphInstance<N> | undefined>(undefined);

  useEffect(() => {
    const instance = localRef.current;
    if (!instance) return;
    instanceRef.current = instance;
    onReady?.(instance);
    // Mount only: the instance is stable for this component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // react-force-graph types its ref against NodeObject<N>, which a bare
  // generic N cannot prove it satisfies; the instance is the same object.
  return (
    <ForceGraph2D
      ref={localRef as React.MutableRefObject<never>}
      {...props}
    />
  );
}
