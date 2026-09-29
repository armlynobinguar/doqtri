-- One row per upload attempt, written before any conversion runs.
--
-- The original file is archived to the private `uploads` bucket as the first
-- ingest stage, and this row points at it. A conversion that fails or times out
-- therefore leaves a retryable record instead of losing the user's upload, and
-- the vault can list failed imports without guessing from Storage.
--
-- The browser may read its own rows (to show failed imports). Every write goes
-- through /api/ingest with the service role, so no insert/update policies.

create table public.ingests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  object_path text not null,
  filename    text not null,
  kind        text not null check (kind in ('pdf', 'docx', 'pptx', 'text')),
  status      text not null default 'pending'
              check (status in ('pending', 'succeeded', 'failed')),
  error_code  text,
  error       text,
  document_id uuid references public.documents(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.ingests enable row level security;

create policy "own ingests - select" on public.ingests
  for select using (auth.uid() = user_id);
create policy "own ingests - delete" on public.ingests
  for delete using (auth.uid() = user_id);

create index ingests_user_status_idx
  on public.ingests (user_id, status, created_at desc);
