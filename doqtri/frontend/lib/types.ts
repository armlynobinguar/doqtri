/** A row of public.documents. */
export type DocumentRow = {
  id: string;
  user_id: string;
  title: string;
  markdown: string;
  updated_at: string;
};

/** What the explorer, tabs, and quick switcher need to list a note. */
export type NoteSummary = {
  id: string;
  title: string;
  updated_at: string;
};

/**
 * The graph input shape. Deliberately narrow: the graph is derived from
 * markdown and nothing else, so no other columns belong here.
 */
export type Doc = {
  id: string;
  title: string;
  markdown: string;
};
