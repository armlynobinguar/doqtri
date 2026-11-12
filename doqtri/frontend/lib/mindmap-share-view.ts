import { ZOOM_REVEAL_MIN_NODES } from "@/lib/mindmap-graph";
import { defaultStyleFor, parseStyle, type MindmapStyle } from "@/lib/mindmap-style";

/**
 * How the shared mindmap page (/m/<token>, WP-4.7, DOQ-53) styles the map:
 * the sender's `global` style as stored with the link, parsed the way the
 * global mindmap parses it, or the global map's default look (the free
 * layout: a forest, not one tree) when they never restyled it.
 *
 * One change: a map big enough for zoom reveal (ZOOM_REVEAL_MIN_NODES) opens
 * with "Hide on zoom out" on, whatever the sender had. That is the on-screen
 * path that keeps labels readable on a big map: the outline's labels are
 * enlarged to stay legible when zoomed out (labelBoost), and deeper levels
 * appear as they become readable instead of thousands of specks. The viewer
 * can switch it off in the toolbar; nothing is saved either way.
 */
export function sharedMindmapStyle(raw: unknown, nodeCount: number): MindmapStyle {
  const fallback = defaultStyleFor("free");
  const style = raw === null || raw === undefined ? fallback : parseStyle(raw, fallback);
  return nodeCount >= ZOOM_REVEAL_MIN_NODES ? { ...style, hideOnZoomOut: true } : style;
}
