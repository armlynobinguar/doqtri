"use client";

import { useEffect, useRef } from "react";
import type { ForceGraphMethods, NodeObject } from "react-force-graph-2d";

/** Screen pixels the pointer may travel before a press becomes a drag. */
const DRAG_TOLERANCE_PX = 4;

/**
 * Share of every other node's velocity kept per tick while one is dragged.
 * A drag reheats the simulation to full strength so the engine keeps drawing;
 * this holds the rest of the map to a gentle follow instead of a reshuffle.
 */
const DRAG_DAMPING = 0.35;

type Positioned = { x?: number; y?: number; vx?: number; vy?: number; fx?: number; fy?: number };

export type NodePointerOptions<N extends Positioned> = {
  /** The element wrapping the graph's canvas. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  instanceRef: React.RefObject<ForceGraphMethods<N, Record<string, unknown>> | undefined>;
  /** The live node objects, in draw order. */
  getNodes: () => N[];
  /** Whether graph point (x, y) at zoom `k` lands on `node`. */
  hitTest: (node: N, x: number, y: number, k: number) => boolean;
  isClickable?: (node: N) => boolean;
  onClick?: (node: N) => void;
  onRightClick?: (node: N) => void;
  /** Called once a drag ends, with `fx`/`fy` still holding the drop point. */
  onDragEnd?: (node: N) => void;
  /** Native tooltip text for a hovered node. */
  tooltip?: (node: N) => string | undefined;
};

/**
 * Hover, click, right-click and drag for force-graph nodes, found by geometry.
 *
 * force-graph finds the node under the pointer by painting every node in a
 * unique colour on a hidden canvas and reading back one pixel. Browsers that
 * resist canvas fingerprinting — Brave Shields, Firefox's resistFingerprinting
 * — perturb exactly that readback, so some nodes come back as nothing: no hand
 * cursor, no click, no drag, for the same nodes every time. The positions are
 * already on the node objects, so this tests against them instead. The graph
 * must be rendered with `enablePointerInteraction={false}` and
 * `enableNodeDrag={false}` so the two do not both answer the same press.
 *
 * Everything runs through refs and direct DOM writes: re-rendering the graph
 * hands force-graph fresh callbacks, which it answers by reheating the layout.
 */
export function useNodePointer<N extends Positioned>(options: NodePointerOptions<N>) {
  // The listeners are attached once; they read the latest options from here.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    const container = options.containerRef.current;
    if (!container) return;

    let pressed: { node: N; startX: number; startY: number; offsetX: number; offsetY: number } | null = null;
    let dragging: N | null = null;

    const canvasOf = () => container.querySelector("canvas");

    /** The topmost node under a client point, with that point in graph units. */
    function pick(clientX: number, clientY: number) {
      const { instanceRef, getNodes, hitTest } = optionsRef.current;
      const instance = instanceRef.current;
      const canvas = canvasOf();
      if (!instance || !canvas) return null;

      const rect = canvas.getBoundingClientRect();
      const point = instance.screen2GraphCoords(clientX - rect.left, clientY - rect.top);
      const k = instance.zoom();
      const nodes = getNodes();
      // Last drawn is on top, so it wins an overlap.
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (hitTest(nodes[i], point.x, point.y, k)) return { node: nodes[i], point };
      }
      return { node: null, point };
    }

    function setHover(node: N | null) {
      const { isClickable, onDragEnd, tooltip } = optionsRef.current;
      const canvas = canvasOf();
      if (!canvas) return;
      canvas.style.cursor = dragging
        ? "grabbing"
        : node && isClickable?.(node)
          ? "pointer"
          : node && onDragEnd
            ? "grab"
            : "";
      canvas.title = (node && tooltip?.(node)) || "";
    }

    function setDamping(on: boolean) {
      const instance = optionsRef.current.instanceRef.current;
      if (!instance) return;
      let nodes: NodeObject<N>[] = [];
      const damp = Object.assign(
        () => {
          for (const node of nodes) {
            if (node === dragging) continue;
            node.vx = (node.vx ?? 0) * DRAG_DAMPING;
            node.vy = (node.vy ?? 0) * DRAG_DAMPING;
          }
        },
        { initialize: (given: NodeObject<N>[]) => (nodes = given) },
      );
      instance.d3Force("drag-damping", on ? damp : null);
    }

    // Capture phase, so a press on a node never reaches the canvas, where
    // d3-zoom would start panning the whole view instead.
    function onDown(event: PointerEvent) {
      if (event.target !== canvasOf()) return;
      const hit = pick(event.clientX, event.clientY);
      if (!hit?.node) return;
      event.stopPropagation();
      if (event.button !== 0) return;
      pressed = {
        node: hit.node,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: (hit.node.x ?? 0) - hit.point.x,
        offsetY: (hit.node.y ?? 0) - hit.point.y,
      };
      container!.setPointerCapture(event.pointerId);
    }

    // d3-zoom listens for mousedown and touchstart, not pointerdown, so those
    // have to be stopped too.
    function onLegacyDown(event: MouseEvent | TouchEvent) {
      if (event.target !== canvasOf()) return;
      const touch = "touches" in event ? event.touches[0] : null;
      const x = touch ? touch.clientX : (event as MouseEvent).clientX;
      const y = touch ? touch.clientY : (event as MouseEvent).clientY;
      if (pick(x, y)?.node) event.stopPropagation();
    }

    function onMove(event: PointerEvent) {
      if (!pressed) {
        if (event.target !== canvasOf()) return;
        setHover(pick(event.clientX, event.clientY)?.node ?? null);
        return;
      }

      const instance = optionsRef.current.instanceRef.current;
      if (!instance) return;
      const { node } = pressed;

      if (!dragging) {
        const moved = Math.hypot(event.clientX - pressed.startX, event.clientY - pressed.startY);
        if (moved < DRAG_TOLERANCE_PX || !optionsRef.current.onDragEnd) return;
        dragging = node;
        setDamping(true);
        setHover(node);
      }

      const canvas = canvasOf();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const point = instance.screen2GraphCoords(event.clientX - rect.left, event.clientY - rect.top);
      node.fx = node.x = point.x + pressed.offsetX;
      node.fy = node.y = point.y + pressed.offsetY;
      // Keeps the engine ticking, so the drag is drawn and its links follow.
      instance.d3ReheatSimulation();
    }

    function onUp(event: PointerEvent) {
      if (!pressed) return;
      const { node } = pressed;
      pressed = null;
      if (container!.hasPointerCapture(event.pointerId)) {
        container!.releasePointerCapture(event.pointerId);
      }

      if (dragging) {
        dragging = null;
        setDamping(false);
        optionsRef.current.onDragEnd?.(node);
        setHover(node);
        return;
      }

      const { isClickable, onClick } = optionsRef.current;
      if (isClickable?.(node) ?? true) onClick?.(node);
    }

    function onContextMenu(event: MouseEvent) {
      if (event.target !== canvasOf()) return;
      const hit = pick(event.clientX, event.clientY);
      if (!hit?.node || !optionsRef.current.onRightClick) return;
      event.preventDefault();
      optionsRef.current.onRightClick(hit.node);
    }

    function onLeave() {
      if (!pressed) setHover(null);
    }

    container.addEventListener("pointerdown", onDown, { capture: true });
    container.addEventListener("mousedown", onLegacyDown, { capture: true });
    container.addEventListener("touchstart", onLegacyDown, { capture: true, passive: true });
    container.addEventListener("pointermove", onMove);
    container.addEventListener("pointerup", onUp);
    container.addEventListener("pointercancel", onUp);
    container.addEventListener("pointerleave", onLeave);
    container.addEventListener("contextmenu", onContextMenu);
    return () => {
      container.removeEventListener("pointerdown", onDown, { capture: true });
      container.removeEventListener("mousedown", onLegacyDown, { capture: true });
      container.removeEventListener("touchstart", onLegacyDown, { capture: true });
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerup", onUp);
      container.removeEventListener("pointercancel", onUp);
      container.removeEventListener("pointerleave", onLeave);
      container.removeEventListener("contextmenu", onContextMenu);
    };
    // The container element is stable for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
