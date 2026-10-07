/**
 * Canvas-side mirrors of the brand palette in app/globals.css.
 *
 * `react-force-graph-2d` paints into a <canvas>, so it needs concrete color
 * strings rather than CSS custom properties. These values must stay in sync
 * with the tokens in globals.css — they are the same colors from the brand
 * system.
 */
export const GRAPH_COLORS = {
  /** Resolved note nodes — the pale pearl primary. */
  node: "#c9cadf",
  /** Unresolved [[link]] targets: stroke only, no fill, dimmed. */
  ghostStroke: "#4a4e58",
  /**
   * The active note, drawn with a halo ring in full white so it outranks the
   * pearl of every other resolved node.
   */
  activeRing: "#f4f5f7",
  link: "#24272d",
  linkHighlight: "#c9cadf",
  label: "#7d828d",
  labelActive: "#f4f5f7",
  background: "#08090b",
} as const;

/**
 * The mindmap canvas draws labelled pills rather than dots, so it needs a fill
 * and a text color per node kind instead of the single accent the graph uses.
 *
 * The ramp runs from white at the root to dim graphite at the leaves, which is what
 * carries the hierarchy once the radial layout has spread the tree out. Muted
 * lavender marks the two nodes that are not part of a single document's tree — the
 * document nodes and the shared-concept hubs in the global view — because
 * purple is the app's derived / on-chain affordance color.
 */
export const MINDMAP_COLORS = {
  root: { fill: "#24252c", stroke: "#f4f5f7", text: "#f4f5f7" },
  theme: { fill: "#1a1b20", stroke: "#8a8d97", text: "#dfe1e6" },
  concept: { fill: "#141519", stroke: "#3a3d45", text: "#b0b4bd" },
  detail: { fill: "#0f1013", stroke: "#26282e", text: "#7d828d" },
  document: { fill: "#1d1c2a", stroke: "#a9a3dc", text: "#e6e4f6" },
  hub: { fill: "#18172a", stroke: "#827cb8", text: "#d3d0ee" },
  link: "#34373f",
  background: "#08090b",
} as const;
