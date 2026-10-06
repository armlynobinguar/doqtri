-- Mindmap node → GitHub issue or pull request.
--
-- A node reaches Built / Verified on-chain only when its owner signs a
-- set_node_status transaction. These rows let Doqtri watch the GitHub work
-- behind a node and say when it is ready to move: /api/github/status reads the
-- linked issue or PR (merged? CI passing?) and suggests the next status, and
-- the owner signs it from the ship panel. Nothing here writes to the chain.
--
-- node_id is positional (root, h0, h1, ...) because that is what the contract
-- stores, so node_label keeps the heading text the link was made against. If
-- the note's headings are reordered, the label at that id no longer matches and
-- the UI asks the owner to relink before syncing.
--
-- One link per node. Owners read, create and delete their own links; a link
-- can only point at one of the owner's own documents.

create table public.node_links (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  node_id     text not null check (char_length(node_id) between 1 and 64),
  node_label  text not null default '',
  repo        text not null check (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  number      integer not null check (number > 0),
  created_at  timestamptz not null default now(),
  unique (document_id, node_id)
);

alter table public.node_links enable row level security;

create policy "own node links - select" on public.node_links
  for select using (auth.uid() = user_id);
create policy "own node links - insert" on public.node_links
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.documents d
      where d.id = document_id and d.user_id = auth.uid()
    )
  );
create policy "own node links - delete" on public.node_links
  for delete using (auth.uid() = user_id);

create index node_links_document_idx on public.node_links (document_id);
