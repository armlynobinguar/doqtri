"use client";

import { useCallback, useSyncExternalStore } from "react";
import { parseStyle, type MindmapStyle } from "@/lib/mindmap-style";

/**
 * A map's studio style, remembered in this browser.
 *
 * One entry per map (`scope`), so a document's map and the global map can look
 * different. It is a per-viewer convenience like a remembered panel width —
 * nothing else reads it — so browser storage is the right home, and a blocked
 * or cleared store simply falls back to the default look.
 */

const PREFIX = "mindmap-style:";
const cache = new Map<string, MindmapStyle>();
const listeners = new Set<() => void>();

function read(scope: string, fallback: MindmapStyle): MindmapStyle {
  const cached = cache.get(scope);
  if (cached) return cached;
  let style = fallback;
  try {
    const raw = window.localStorage.getItem(PREFIX + scope);
    if (raw) style = parseStyle(JSON.parse(raw), fallback);
  } catch {
    // Unreadable or blocked storage: the default look.
  }
  cache.set(scope, style);
  return style;
}

function write(scope: string, style: MindmapStyle) {
  cache.set(scope, style);
  try {
    window.localStorage.setItem(PREFIX + scope, JSON.stringify(style));
  } catch {
    // Storage full or blocked: the style still holds for this visit.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMindmapStyle(scope: string, fallback: MindmapStyle) {
  const style = useSyncExternalStore(
    subscribe,
    () => read(scope, fallback),
    () => fallback,
  );

  const setStyle = useCallback(
    (next: MindmapStyle | ((current: MindmapStyle) => MindmapStyle)) => {
      const current = read(scope, fallback);
      write(scope, typeof next === "function" ? next(current) : next);
    },
    [scope, fallback],
  );

  return [style, setStyle] as const;
}
