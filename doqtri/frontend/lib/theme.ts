/**
 * Canvas-side mirrors of the brand palette in app/globals.css.
 *
 * `react-force-graph-2d` paints into a <canvas>, so it needs concrete color
 * strings rather than CSS custom properties. These values must stay in sync
 * with the tokens in globals.css — they are the same colors from the brand
 * system.
 */
export const GRAPH_COLORS = {
  /** Resolved note nodes — the blue accent. */
  node: "#4a9df0",
  /** Unresolved [[link]] targets: stroke only, no fill, dimmed. */
  ghostStroke: "#5a6273",
  /**
   * The active note, drawn with a halo ring. Deliberately neutral rather than
   * purple: purple is reserved for on-chain and AI affordances, and the blue
   * is already doing the work of marking resolved nodes.
   */
  activeRing: "#e7e9ee",
  link: "#2a313d",
  linkHighlight: "#4a9df0",
  label: "#8b93a3",
  labelActive: "#e7e9ee",
  background: "#0c0f14",
} as const;

/**
 * The mindmap canvas draws labelled pills rather than dots, so it needs a fill
 * and a text color per node kind instead of the single accent the graph uses.
 *
 * The ramp runs from bright at the root to dim at the leaves, which is what
 * carries the hierarchy once the radial layout has spread the tree out. Purple
 * marks the two nodes that are not part of a single document's tree — the
 * document nodes and the shared-concept hubs in the global view — because
 * purple is the app's derived / on-chain affordance color.
 */
export const MINDMAP_COLORS = {
  root: { fill: "#15304d", stroke: "#4a9df0", text: "#e7f1fc" },
  theme: { fill: "#132233", stroke: "#3a7cc0", text: "#cddff2" },
  concept: { fill: "#161b24", stroke: "#3f4552", text: "#b3bac7" },
  detail: { fill: "#11151c", stroke: "#2a313d", text: "#8b93a3" },
  document: { fill: "#2a2140", stroke: "#b38bef", text: "#ece3fb" },
  hub: { fill: "#211a33", stroke: "#9572cc", text: "#d8cbf2" },
  link: "#2f3642",
  background: "#0c0f14",
} as const;
