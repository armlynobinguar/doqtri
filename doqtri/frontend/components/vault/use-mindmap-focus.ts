"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { createFocusIndex, type MindmapGraph } from "@/lib/mindmap-graph";

/**
 * Focus on hover: one node's branch stays lit while the rest of the map dims.
 *
 * Shared by the 2D and 3D renderers, which differ only in how they draw the
 * dimming. The state lives in a ref rather than React state on purpose: it is
 * read at draw time, every frame of a fade, and routing that through renders
 * would rebuild the painter — and with it every node's cached size.
 */

/** How long the pointer must rest before focus moves, so sweeping across a dense map does not strobe. */
const HOVER_DELAY_MS = 100;

/** Length of the dim/undim fade. */
const FADE_MS = 150;

/** Opacity of an unrelated node once fully dimmed. */
const DIM_OPACITY = 0.2;

export type FocusState = {
  /** The node the focus is on — what the lock button sits beside. */
  id: string | null;
  /** The lit nodes, or null when nothing is focused. */
  set: Set<string> | null;
  /** How far the fade has run, 0 (no dimming) to 1 (fully dimmed). */
  t: number;
};

/** Opacity for a node under the current focus. */
export function focusAlpha(state: FocusState, id: string): number {
  if (!state.set || state.set.has(id)) return 1;
  return 1 - (1 - DIM_OPACITY) * state.t;
}

/** Whether a link is part of the lit branch (always true with no focus). */
export function linkIsLit(state: FocusState, sourceId: string, targetId: string): boolean {
  return !state.set || state.t === 0 || (state.set.has(sourceId) && state.set.has(targetId));
}

/** Opacity for a link: lit only when both of its ends are. */
export function linkFocusAlpha(state: FocusState, sourceId: string, targetId: string): number {
  if (!state.set || (state.set.has(sourceId) && state.set.has(targetId))) return 1;
  return 1 - (1 - DIM_OPACITY) * state.t;
}

export function useMindmapFocus(
  graph: MindmapGraph,
  enabled: boolean,
  /** Called on every frame of a fade, and on any instant change, to redraw. */
  onFrame: (state: FocusState) => void,
  /**
   * A node whose highlight is locked on: it stays lit and hover, holds and
   * taps on empty space leave it alone until it is unlocked.
   */
  lockedId: string | null = null,
) {
  const index = useMemo(() => createFocusIndex(graph), [graph]);
  const stateRef = useRef<FocusState>({ id: null, set: null, t: 0 });
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frameRef = useRef(0);
  /** A touch hold stays until the next tap on empty space, not until the finger lifts. */
  const stickyRef = useRef(false);

  const fadeTo = useCallback((target: 0 | 1) => {
    cancelAnimationFrame(frameRef.current);
    const from = stateRef.current.t;
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / FADE_MS);
      stateRef.current.t = from + (target - from) * progress;
      if (target === 0 && progress === 1) {
        stateRef.current.set = null;
        stateRef.current.id = null;
      }
      onFrameRef.current(stateRef.current);
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
  }, []);

  const focusOn = useCallback(
    (id: string | null) => {
      const set = id ? index(id) : null;
      const state = stateRef.current;
      if (set) {
        const showing = state.set !== null && state.t > 0;
        state.set = set;
        state.id = id;
        // Moving from one branch to another swaps the lit set in place; only
        // going from nothing to something fades in.
        if (!showing) state.t = 0;
        if (state.t < 1) fadeTo(1);
        else onFrameRef.current(stateRef.current);
      } else if (state.set) {
        fadeTo(0);
      }
    },
    [index, fadeTo],
  );

  // A new map, or focus switched off: drop whatever was lit, at once.
  useEffect(() => {
    clearTimeout(timerRef.current);
    cancelAnimationFrame(frameRef.current);
    stickyRef.current = false;
    stateRef.current = { id: null, set: null, t: 0 };
    onFrameRef.current(stateRef.current);
  }, [index, enabled]);

  // Locking focuses the node at once; unlocking lets go, back to plain hover.
  // Declared after the reset above so a remount or a new map re-applies it.
  const lockedRef = useRef(lockedId);
  useEffect(() => {
    const wasLocked = lockedRef.current !== null;
    lockedRef.current = lockedId;
    if (!enabled) return;
    clearTimeout(timerRef.current);
    if (lockedId) {
      stickyRef.current = true;
      focusOn(lockedId);
    } else if (wasLocked) {
      stickyRef.current = false;
      focusOn(null);
    }
  }, [lockedId, enabled, focusOn]);

  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
      cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  /** The mouse is over `id`, or over nothing. */
  const hover = useCallback(
    (id: string | null) => {
      if (!enabled || stickyRef.current || lockedRef.current) return;
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => focusOn(id), HOVER_DELAY_MS);
    },
    [enabled, focusOn],
  );

  /** A finger held on `id`: focus at once, and keep it after the finger lifts. */
  const hold = useCallback(
    (id: string) => {
      if (!enabled || lockedRef.current) return;
      clearTimeout(timerRef.current);
      stickyRef.current = true;
      focusOn(id);
    },
    [enabled, focusOn],
  );

  /** A press on empty space: let go of any focus. */
  const clear = useCallback(() => {
    if (lockedRef.current) return;
    clearTimeout(timerRef.current);
    stickyRef.current = false;
    focusOn(null);
  }, [focusOn]);

  return { stateRef, hover, hold, clear };
}
