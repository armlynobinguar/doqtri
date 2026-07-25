-- Applied to Supabase project "Doqtri" (omoalynhmtbqffogjvoy).
--
-- One table is the whole data model. The graph is never stored: it is parsed
-- from `markdown` at render time, which is what makes staleness impossible.
-- If a feature seems to need a second table, it is a v2 non-goal.

create table public.documents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text not null,
  markdown   text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.documents enable row level security;

create policy "own docs - select" on public.documents
  for select using (auth.uid() = user_id);
create policy "own docs - insert" on public.documents
  for insert with check (auth.uid() = user_id);
create policy "own docs - update" on public.documents
  for update using (auth.uid() = user_id);
create policy "own docs - delete" on public.documents
  for delete using (auth.uid() = user_id);

-- Titles are the graph's join key and are matched case-insensitively.
create index documents_user_title_idx
  on public.documents (user_id, lower(title));
