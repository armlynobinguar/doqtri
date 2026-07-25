import type { DocMindmap } from "@/lib/mindmap-types";

/** A row of public.documents. */
export type DocumentRow = {
  id: string;
  user_id: string;
  title: string;
  markdown: string;
  updated_at: string;
  mindmap: DocMindmap | null;
  mindmap_hash: string | null;
};

/** What the explorer, tabs, and quick switcher need to list a note. */
export type NoteSummary = {
  id: string;
  title: string;
  updated_at: string;
};

/**
 * The graph input shape. The vault graph still derives entirely from
 * `markdown` — the two mindmap fields are for the mindmap views only.
 *
 * `mindmap` is null when extraction has not run or failed; `mindmapStale` says
 * the stored map was built from different markdown than the note now holds.
 * Staleness is decided on the server, since hashing lives there.
 */
export type Doc = {
  id: string;
  title: string;
  markdown: string;
  mindmap?: DocMindmap | null;
  mindmapStale?: boolean;
};
