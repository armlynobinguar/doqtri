import { describe, expect, it } from "vitest";
import { ZOOM_REVEAL_MIN_NODES } from "@/lib/mindmap-graph";
import { defaultStyleFor } from "@/lib/mindmap-style";
import { sharedMindmapStyle } from "@/lib/mindmap-share-view";

describe("sharedMindmapStyle", () => {
  it("is the global map's default look when the sender never restyled it", () => {
    expect(sharedMindmapStyle(null, 10)).toEqual(defaultStyleFor("free"));
  });

  it("keeps the sender's look", () => {
    const style = sharedMindmapStyle({ textScale: 1.6, shape: "hexagon", view: "3d" }, 10);
    expect(style).toMatchObject({ textScale: 1.6, shape: "hexagon", view: "3d", hideOnZoomOut: false });
  });

  it("turns on zoom reveal for a map big enough for it, so labels stay readable (DOQ-53)", () => {
    expect(sharedMindmapStyle({ hideOnZoomOut: false }, ZOOM_REVEAL_MIN_NODES).hideOnZoomOut).toBe(true);
    expect(sharedMindmapStyle(null, 5000).hideOnZoomOut).toBe(true);
    expect(sharedMindmapStyle(null, ZOOM_REVEAL_MIN_NODES - 1).hideOnZoomOut).toBe(false);
  });
});
