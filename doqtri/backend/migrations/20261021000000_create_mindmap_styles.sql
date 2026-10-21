-- Mindmap studio styles, saved per user instead of per browser.
--
-- One row per map a user has restyled: `global` for the vault-wide map, or
-- `doc:<document id>` for one note's map. The studio keeps the style in memory
-- and upserts it here from the browser a moment after the last change, so the
-- look follows the user to every device.
--
-- `document_id` is redundant with `scope` but carries the foreign key, so a
-- note's style row goes away with the note. The demo vault's maps are never
-- stored here: demo visitors are not signed in.
--
-- The browser writes these rows directly under RLS. The style is only ever
-- read back by its owner, and parseStyle() cleans it on read, so the database
-- only bounds its size.

create table public.mindmap_styles (
  user_id     uuid not null references auth.users(id) on delete cascade,
  scope       text not null,
  document_id uuid references public.documents(id) on delete cascade,
  style       jsonb not null check (
    jsonb_typeof(style) = 'object' and octet_length(style::text) <= 65536
  ),
  updated_at  timestamptz not null default now(),
  primary key (user_id, scope),
  check (
    (scope = 'global' and document_id is null)
    or (document_id is not null and scope = 'doc:' || document_id::text)
  )
);

alter table public.mindmap_styles enable row level security;

create policy "own mindmap styles - select" on public.mindmap_styles
  for select using ((select auth.uid()) = user_id);
create policy "own mindmap styles - insert" on public.mindmap_styles
  for insert with check (
    (select auth.uid()) = user_id
    and (
      document_id is null
      or exists (
        select 1 from public.documents d
        where d.id = document_id and d.user_id = (select auth.uid())
      )
    )
  );
create policy "own mindmap styles - update" on public.mindmap_styles
  for update using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (
      document_id is null
      or exists (
        select 1 from public.documents d
        where d.id = document_id and d.user_id = (select auth.uid())
      )
    )
  );
create policy "own mindmap styles - delete" on public.mindmap_styles
  for delete using ((select auth.uid()) = user_id);

create index mindmap_styles_document_idx
  on public.mindmap_styles (document_id) where document_id is not null;

-- The server stamps every write, so `updated_at` works as a version: a device
-- with unsaved edits remembers the version it edited, and if the row has moved
-- on since, another device saved first and its style wins.
create function public.mindmap_styles_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger mindmap_styles_touch
  before insert or update on public.mindmap_styles
  for each row execute function public.mindmap_styles_touch();
