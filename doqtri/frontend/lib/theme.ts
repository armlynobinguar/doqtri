/**
 * Canvas-side mirrors of the Cursor palette in app/globals.css.
 *
 * `react-force-graph-2d` paints into a <canvas>, so it needs concrete color
 * strings rather than CSS custom properties. These values must stay in sync
 * with the tokens in globals.css — they are the same colors from the spec.
 */
export const GRAPH_COLORS = {
  /** Resolved note nodes — the single accent. */
  node: "#4d9dff",
  /** Unresolved [[link]] targets: stroke only, no fill, dimmed. */
  ghostStroke: "#5a5a5a",
  /**
   * The active note, drawn with a halo ring. Deliberately neutral rather than
   * purple: purple is reserved for AI affordances, and the accent is already
   * doing the work of marking resolved nodes.
   */
  activeRing: "#d4d4d4",
  link: "#2a2a2a",
  linkHighlight: "#4d9dff",
  label: "#808080",
  labelActive: "#d4d4d4",
  background: "#1e1e1e",
} as const;

/**
 * The mindmap canvas draws labelled pills rather than dots, so it needs a fill
 * and a text color per node kind instead of the single accent the graph uses.
 *
 * The ramp runs from bright at the root to dim at the leaves, which is what
 * carries the hierarchy once the radial layout has spread the tree out. Purple
 * marks the two nodes that are not part of a single document's tree — the
 * document nodes and the shared-concept hubs in the global view — because
 * purple is the app's AI/derived affordance color.
 */
export const MINDMAP_COLORS = {
  root: { fill: "#2c4c74", stroke: "#4d9dff", text: "#e6f0fb" },
  theme: { fill: "#26374a", stroke: "#3d7ac4", text: "#cfe0f2" },
  concept: { fill: "#26292e", stroke: "#3a4048", text: "#a8b0ba" },
  detail: { fill: "#212327", stroke: "#31353b", text: "#7d848d" },
  document: { fill: "#3a2c56", stroke: "#8b5cf6", text: "#e2d8f7" },
  hub: { fill: "#2f2547", stroke: "#7c4ddb", text: "#d0c2ef" },
  link: "#333940",
  background: "#1e1e1e",
} as const;
