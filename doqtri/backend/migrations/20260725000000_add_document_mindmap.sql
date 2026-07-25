-- Applied to Supabase project "Doqtri" (omoalynhmtbqffogjvoy).
--
-- v2, progress/001-document-mindmap.md.
--
-- This deliberately breaks the v1 rule that no derived view is ever stored. A
-- semantic concept map is not derivable from the markdown by parsing — it takes
-- a model — so there is no version of the document mindmap that keeps the rule.
--
-- Staleness is handled instead of prevented: `mindmap_hash` records the digest
-- of the markdown the map was generated from, so the UI can tell when the two
-- have drifted apart and offer to regenerate. Null `mindmap` is normal, not an
-- error: extraction is best-effort at ingest, and older rows predate it. Both
-- cases fall back to the heading tree in lib/mindmap.ts.

alter table public.documents
  add column mindmap      jsonb,
  add column mindmap_hash text;

comment on column public.documents.mindmap is
  'DocMindmap JSON (see lib/mindmap-types.ts). Null when extraction failed or has not run.';
comment on column public.documents.mindmap_hash is
  'SHA-256 of the markdown this mindmap was generated from. Differs from the current markdown => stale.';
