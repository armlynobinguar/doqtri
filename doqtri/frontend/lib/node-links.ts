import type { QditLinkState } from "@/lib/node-remap";

/**
 * Node links as the ship panel and the routes see them (WP-2.5). A heading
 * links to at most one thing, of one provider (D-08): a GitHub issue or pull
 * request, or a qdit milestone. Pure and browser-safe.
 */

export type LinkProvider = "github" | "qdit";

/** The columns every provider shares. */
export const NODE_LINK_COLUMNS = "id, provider, node_id, node_label, created_at";

/** A GitHub row's own columns. */
export const GITHUB_LINK_COLUMNS = "id, node_id, node_label, repo, number";

/** A qdit row's own columns. */
export const QDIT_LINK_COLUMNS =
  "id, node_id, node_label, qdit_project_id, qdit_milestone_id, qdit_link_id, qdit_url, qdit_doc_version, qdit_state";

export type QditLinkRow = {
  id: string;
  node_id: string;
  node_label: string;
  qdit_project_id: string;
  qdit_milestone_id: string;
  qdit_link_id: string;
  qdit_url: string | null;
  qdit_doc_version: number | null;
  qdit_state: QditLinkState;
};

export type DocProjectLinkRow = {
  document_id: string;
  project_id: string;
  project_name: string;
  project_slug: string;
  project_url: string | null;
  qdit_link_id: string;
  doc_url: string;
};

export const DOC_PROJECT_LINK_COLUMNS =
  "document_id, project_id, project_name, project_slug, project_url, qdit_link_id, doc_url";

/** A mindmap heading the ship panel offers to link. */
export type LinkableNode = { id: string; label: string };

const HEADING_ID = /^h(0|[1-9][0-9]{0,8})$/;

/**
 * The nodes a provider may link, minus the ones already linked by any
 * provider. Only headings link, never concept-map nodes (D-11): GitHub takes
 * the root too, as it always has; a qdit milestone stands for a heading.
 */
export function linkableNodes(
  nodes: LinkableNode[],
  provider: LinkProvider,
  linked: Iterable<string>,
): LinkableNode[] {
  const taken = new Set(linked);
  return nodes.filter(
    (n) => !taken.has(n.id) && (HEADING_ID.test(n.id) || (provider === "github" && n.id === "root")),
  );
}

export function isHeadingId(id: string): boolean {
  return HEADING_ID.test(id);
}

/** What the ship panel says about a qdit link in each state. */
export const QDIT_STATE_TEXT: Record<QditLinkState, { tag: string; note: string | null }> = {
  linked: { tag: "Linked", note: null },
  pending: {
    tag: "Updating",
    note: "The heading moved or was renamed. qdit is updated after the save; Retry if it stays like this.",
  },
  ambiguous: {
    tag: "Check",
    note: "More than one heading reads like this one now. Pick the right heading to relink it.",
  },
  broken: {
    tag: "Broken",
    note: "This heading was deleted, or qdit no longer has the link. Relink it to a heading or unlink it; the milestone stays in qdit.",
  },
  conflict: {
    tag: "Conflict",
    note: "qdit already has another milestone on this heading. Relink this one to another heading or unlink it.",
  },
};
