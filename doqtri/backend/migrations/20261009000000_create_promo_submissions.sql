-- Mindmap showcase promo: users submit 1-4 screenshots of their mindmaps for a
-- chance to win a prize.
--
-- Screenshots go to the private `promo-submissions` bucket, which the browser
-- reaches only through signed upload URLs that /api/promo/uploads mints for
-- `<user id>/<upload id>/<n>.<ext>`. The bucket itself enforces the size and
-- type limits, so a client that skips the form's checks is still refused.
-- No storage RLS policies are added on purpose, same as `uploads`.
--
-- One entry per user per promo. /api/promo/submissions writes the row with the
-- service role after checking every listed file exists under the caller's own
-- folder; resubmitting replaces the entry and deletes the old screenshots.
-- Owners can read their own row; nothing else is exposed to the client.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'promo-submissions',
  'promo-submissions',
  false,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

create table public.promo_submissions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  promo       text not null check (promo ~ '^[a-z0-9-]{1,64}$'),
  image_paths text[] not null check (cardinality(image_paths) between 1 and 4),
  caption     text not null default '' check (char_length(caption) <= 500),
  contact     text not null default '' check (char_length(contact) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, promo)
);

alter table public.promo_submissions enable row level security;

create policy "own promo submissions - select" on public.promo_submissions
  for select using (auth.uid() = user_id);

create index promo_submissions_promo_idx on public.promo_submissions (promo, created_at);
