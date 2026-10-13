-- Template marketplace, phases 2 and 3 (progress/004).
--
-- 1. Each recorded purchase keeps how it was split, so the earnings page can
--    show royalties from derivatives without an event indexer. Filled from
--    the transfers the relay validated, or from the contract's split for
--    Freighter purchases recorded by /api/market/claim.
-- 2. Copy reports: a user names the template they think was copied; an admin
--    compares the two and may hide the copy from the gallery. The contract
--    listing stays: the chain is not censored, only Doqtri's UI.
-- 3. Advisor fixes for the phase 1 tables: auth.uid() evaluated once per
--    query in RLS, and indexes behind two foreign keys.

alter table public.market_purchases
  add column creator_cut  numeric(39, 0) check (creator_cut >= 0),
  add column parent_cut   numeric(39, 0) check (parent_cut >= 0),
  add column treasury_cut numeric(39, 0) check (treasury_cut >= 0),
  -- Parent template's creator at the time of the sale, for royalty totals.
  add column parent_creator_wallet text check (parent_creator_wallet ~ '^[GC][A-Z2-7]{55}$');

create index market_purchases_template_idx on public.market_purchases (template_id, created_at desc);

create table public.market_reports (
  id          uuid primary key default gen_random_uuid(),
  network     text not null check (network in ('testnet', 'mainnet')),
  -- The template reported as a copy, and the one it supposedly copies.
  template_id text not null references public.market_templates(id) on delete cascade,
  original_id text not null references public.market_templates(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reason      text not null default '' check (char_length(reason) <= 1000),
  status      text not null default 'open' check (status in ('open', 'upheld', 'dismissed')),
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz,
  check (template_id <> original_id),
  -- One open report per reporter and pair.
  unique (reporter_id, template_id, original_id)
);

create index market_reports_queue_idx on public.market_reports (network, status, created_at desc);
create index market_reports_template_idx on public.market_reports (template_id);
create index market_reports_original_idx on public.market_reports (original_id);

alter table public.market_reports enable row level security;

create policy "own market reports - select" on public.market_reports
  for select using ((select auth.uid()) = reporter_id);

drop policy "own market templates - select" on public.market_templates;
create policy "own market templates - select" on public.market_templates
  for select using ((select auth.uid()) = creator_id);

drop policy "own market purchases - select" on public.market_purchases;
create policy "own market purchases - select" on public.market_purchases
  for select using ((select auth.uid()) = buyer_id);

create index documents_source_template_idx
  on public.documents (source_template_id) where source_template_id is not null;
create index market_templates_note_idx
  on public.market_templates (note_id) where note_id is not null;
