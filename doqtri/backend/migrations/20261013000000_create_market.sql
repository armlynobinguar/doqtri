-- Template marketplace (progress/004).
--
-- Users publish notes as community templates. The TemplateMarket contract
-- holds the proof (content hash, creator, first-listed time) and moves the
-- money; these tables hold the documents and a cache of what the chain says.
-- The chain stays the source of truth: every listing is re-read from the
-- contract before it shows in the gallery, and every paid copy is checked
-- with `has_purchased` before its body leaves the server.
--
-- Writes go through the service role only (the /api/market routes and the
-- relay). Template bodies are never readable from the browser directly:
-- /api/market/templates serves previews and /api/market/claim serves bodies.

create table public.market_templates (
  -- Same as the on-chain template_id. Assigned by the API, so ids listed
  -- directly on the contract never show up in the gallery.
  id             text primary key check (id ~ '^[a-z2-7]{16}$'),
  network        text not null check (network in ('testnet', 'mainnet')),
  creator_id     uuid not null references auth.users(id) on delete restrict,
  -- G... for wallet accounts, C... for email accounts' passkey wallets.
  creator_wallet text not null check (creator_wallet ~ '^[GC][A-Z2-7]{55}$'),
  note_id        uuid references public.documents(id) on delete set null,
  title          text not null check (char_length(title) between 1 and 120),
  category       text not null check (category in ('Planning', 'Product', 'Web3', 'Learning', 'Work', 'Personal')),
  description    text not null default '' check (char_length(description) <= 280),
  -- The frozen snapshot: the note's markdown without its `# Title` line.
  body           text not null check (char_length(body) <= 50000),
  -- sha256 of `body`; must equal the on-chain content_hash.
  content_hash   text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  token          text not null check (token ~ '^C[A-Z2-7]{55}$'),
  -- In the token's smallest unit (7 decimals for XLM and USDC).
  price          numeric(39, 0) not null check (price >= 0),
  parent_id      text references public.market_templates(id) on delete restrict,
  -- pending: drafted, not yet confirmed on-chain. listed / delisted mirror
  -- the contract's `listed` flag.
  status         text not null default 'pending' check (status in ('pending', 'listed', 'delisted')),
  -- Hidden by an admin after a copy report. The contract listing stays.
  hidden         boolean not null default false,
  -- Copies made from the template, free or paid.
  uses           integer not null default 0 check (uses >= 0),
  -- Cache of the contract's sales / earned, refreshed from get_template.
  sales          integer not null default 0 check (sales >= 0),
  earned         numeric(39, 0) not null default 0 check (earned >= 0),
  created_at     timestamptz not null default now(),
  listed_at      timestamptz
);

create index market_templates_gallery_idx
  on public.market_templates (network, status, hidden, listed_at desc);
create index market_templates_creator_idx
  on public.market_templates (creator_id, network);
create index market_templates_parent_idx
  on public.market_templates (parent_id) where parent_id is not null;

alter table public.market_templates enable row level security;

-- Creators may read their own rows (bodies included) for the earnings page.
create policy "own market templates - select" on public.market_templates
  for select using (auth.uid() = creator_id);

-- Paid purchases, written through by whoever saw the transaction land: the
-- relay for passkey wallets, /api/market/claim for Freighter. Re-verified
-- with `has_purchased` whenever it matters.
create table public.market_purchases (
  network      text not null check (network in ('testnet', 'mainnet')),
  template_id  text not null references public.market_templates(id) on delete restrict,
  buyer_id     uuid not null references auth.users(id) on delete restrict,
  buyer_wallet text not null check (buyer_wallet ~ '^[GC][A-Z2-7]{55}$'),
  tx_hash      text check (tx_hash ~ '^[0-9a-f]{64}$'),
  amount       numeric(39, 0) not null check (amount >= 0),
  created_at   timestamptz not null default now(),
  primary key (template_id, buyer_wallet)
);

create index market_purchases_buyer_idx on public.market_purchases (buyer_id, network);

alter table public.market_purchases enable row level security;

create policy "own market purchases - select" on public.market_purchases
  for select using (auth.uid() = buyer_id);

-- A note made from a community template. Re-publishing that note links the
-- new template to this one as its parent (5% royalty).
alter table public.documents
  add column source_template_id text references public.market_templates(id) on delete set null;

-- Publishing drafts a listing (and spends the relayer's submissions for
-- passkey users); market relay calls are tips, purchases and listing edits.
alter table public.chain_usage drop constraint chain_usage_kind_check;
alter table public.chain_usage
  add constraint chain_usage_kind_check check (kind in ('deploy', 'write', 'publish', 'market'));

-- Atomic `uses + 1`; service role only.
create function public.market_record_use(p_template_id text)
returns void
language sql
set search_path = ''
as $$
  update public.market_templates set uses = uses + 1 where id = p_template_id;
$$;

revoke execute on function public.market_record_use(text) from public, anon, authenticated;
grant execute on function public.market_record_use(text) to service_role;
