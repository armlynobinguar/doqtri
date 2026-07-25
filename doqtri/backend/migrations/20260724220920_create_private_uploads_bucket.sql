-- Applied to Supabase project "Doqtri" (omoalynhmtbqffogjvoy).
--
-- Private bucket for the original uploaded files. Kept for reference only; the
-- markdown in public.documents is what the app reads.
--
-- No storage RLS policies are added on purpose. The browser never touches this
-- bucket: /api/ingest receives the file and writes it with the service role,
-- so the bucket is unreachable from the client by construction.

insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false)
on conflict (id) do nothing;
