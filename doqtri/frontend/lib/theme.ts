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
