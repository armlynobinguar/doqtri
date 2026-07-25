"use client";

import { useEffect, useRef } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type {
  ForceGraphMethods,
  ForceGraphProps,
  NodeObject,
} from "react-force-graph-2d";
import type { MapNode } from "@/lib/mindmap-graph";

export type MindmapNodeDatum = MapNode;
export type MindmapLinkDatum = Record<string, unknown>;
export type MindmapGraphNode = NodeObject<MindmapNodeDatum>;
export type MindmapGraphInstance = ForceGraphMethods<
  MindmapNodeDatum,
  MindmapLinkDatum
>;

export type MindmapForceGraphProps = ForceGraphProps<
  MindmapNodeDatum,
  MindmapLinkDatum
> & {
  /** Receives the graph instance, for imperative access to the d3 forces. */
  instanceRef: React.RefObject<MindmapGraphInstance | undefined>;
  /** Fired once the instance exists, which is later than the parent's mount. */
  onReady?: (instance: MindmapGraphInstance) => void;
};

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
 * silently never apply.
 *
 * `onReady` matters just as much. The dynamic import suspends, so this
 * component mounts a full tick after its parent — any effect the parent runs at
 * its own mount still sees an empty ref. This fires from inside the boundary,
 * once the instance genuinely exists.
 */
export default function MindmapForceGraph({
  instanceRef,
  onReady,
  ...props
}: MindmapForceGraphProps) {
  const localRef = useRef<MindmapGraphInstance | undefined>(undefined);

  useEffect(() => {
    const instance = localRef.current;
    if (!instance) return;
    instanceRef.current = instance;
    onReady?.(instance);
    // Mount only: the instance is stable for this component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <ForceGraph2D ref={localRef} {...props} />;
}
