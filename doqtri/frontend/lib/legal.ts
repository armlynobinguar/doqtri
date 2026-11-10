import "server-only";

/**
 * The gate on the legal pages (WP-4.6, D-114). Merging deploys to production,
 * but nothing legal may be public until a lawyer has reviewed it, and the
 * operator's name stays out of this public repo. Both are solved by one
 * server-only setting: while LEGAL_OPERATOR_NAME is unset, /privacy and /terms
 * are a 404 and every link and notice to them is hidden.
 *
 * Pass the boolean or the name to client components as props. Never give this
 * variable a NEXT_PUBLIC_ name: that would inline it into the browser bundle.
 */

/** The operator's name as the legal pages show it, or null while unset. */
export function legalOperatorName(): string | null {
  return process.env.LEGAL_OPERATOR_NAME?.trim() || null;
}

/** Whether the legal pages, their links and their notices are shown at all. */
export function legalPagesLive(): boolean {
  return legalOperatorName() !== null;
}
