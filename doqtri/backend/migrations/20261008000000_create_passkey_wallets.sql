-- Passkey smart wallets for email accounts (progress/002, phase 2).
--
-- An email account gets a Soroban smart wallet (OpenZeppelin smart account,
-- a C... contract) whose signer is a passkey on the user's device. Fees are
-- paid by a relayer (OpenZeppelin Stellar Channels) through /api/chain/relay.
-- Doqtri never holds a key: these tables only record what exists on-chain.
--
-- Every table carries `network`. Local development runs on testnet against
-- this same project while production runs on mainnet, and one user's wallet
-- has a different address on each.
--
-- Writes go through the service role only (the relay and wallet routes).
-- The browser may read its own wallet and passkeys, and anyone may read
-- chain_writes, whose contents are already public on the ledger.

create table public.smart_wallets (
  user_id    uuid not null references auth.users(id) on delete restrict,
  network    text not null check (network in ('testnet', 'mainnet')),
  address    text not null check (address ~ '^C[A-Z2-7]{55}$'),
  -- Transaction that deployed the wallet contract.
  created_tx text not null check (created_tx ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, network),
  unique (network, address)
);

-- `on delete restrict`: deleting the auth user must not silently erase the
-- record of a wallet that still owns documents on-chain.

alter table public.smart_wallets enable row level security;

create policy "own smart wallets - select" on public.smart_wallets
  for select using (auth.uid() = user_id);

-- Passkeys registered as signers on a wallet. The first comes from wallet
-- creation; backups are added later (phase 7). The private key never leaves
-- the user's device; this is the public half the wallet contract verifies.
create table public.wallet_passkeys (
  credential_id text not null check (credential_id ~ '^[A-Za-z0-9_-]+$'),
  user_id       uuid not null,
  network       text not null,
  -- Uncompressed secp256r1 public key: 0x04 || X || Y.
  public_key    bytea not null check (octet_length(public_key) = 65 and get_byte(public_key, 0) = 4),
  -- WebAuthn relying party the passkey is bound to, e.g. www.doqtri.xyz.
  rp_id         text not null,
  label         text check (char_length(label) <= 64),
  created_at    timestamptz not null default now(),
  primary key (network, credential_id),
  foreign key (user_id, network) references public.smart_wallets (user_id, network) on delete restrict
);

create index wallet_passkeys_user_idx on public.wallet_passkeys (user_id, network);

alter table public.wallet_passkeys enable row level security;

create policy "own wallet passkeys - select" on public.wallet_passkeys
  for select using (auth.uid() = user_id);

-- Every registry write the relay submitted. A smart wallet cannot be a
-- transaction source, so its writes are sent from shared Channels accounts
-- and Horizon has no per-owner operation feed for it (`/accounts/C...`
-- returns 400). This index is how document history finds those writes; each
-- row is re-verified against the ledger by transaction hash when read.
create table public.chain_writes (
  network     text not null check (network in ('testnet', 'mainnet')),
  tx_hash     text not null check (tx_hash ~ '^[0-9a-f]{64}$'),
  document_id uuid not null references public.documents(id) on delete restrict,
  fn          text not null check (fn in ('register_document', 'update_document', 'set_node_status')),
  owner       text not null check (owner ~ '^C[A-Z2-7]{55}$'),
  created_at  timestamptz not null default now(),
  primary key (network, tx_hash)
);

create index chain_writes_document_idx
  on public.chain_writes (network, document_id, created_at);

alter table public.chain_writes enable row level security;

-- Public by design: the public audit page (/d/[docId]) reads it signed out,
-- and every column is already visible on the ledger. No user_id is stored.
create policy "chain writes - public select" on public.chain_writes
  for select using (true);

-- Rate limits for what the relay spends. Channels pays fees under a per-key
-- daily cap, so one account looping deploys or writes could exhaust it for
-- everyone. One row per accepted request.
create table public.chain_usage (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  network    text not null check (network in ('testnet', 'mainnet')),
  kind       text not null check (kind in ('deploy', 'write')),
  created_at timestamptz not null default now()
);

create index chain_usage_user_idx
  on public.chain_usage (user_id, network, kind, created_at desc);
create index chain_usage_global_idx
  on public.chain_usage (network, kind, created_at desc);

alter table public.chain_usage enable row level security;

create policy "own chain usage - select" on public.chain_usage
  for select using (auth.uid() = user_id);

-- Records one relay request if both the user's and everyone's count of that
-- kind in the trailing window are under their limits. Same shape as
-- consume_ai_quota: one transaction under an advisory lock, so concurrent
-- requests cannot both slip under a limit. The lock is per (network, kind),
-- which serializes relay requests of a kind; they are seconds-long chain
-- submissions anyway.
create function public.consume_chain_quota(
  p_user_id      uuid,
  p_network      text,
  p_kind         text,
  p_user_limit   integer,
  p_global_limit integer,
  p_window       interval default interval '24 hours'
)
returns table (allowed boolean, scope text, retry_after_seconds integer)
language plpgsql
set search_path = ''
as $$
declare
  v_user   integer;
  v_global integer;
  v_freed  timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('chain:' || p_network || ':' || p_kind, 0));

  select count(*)::integer into v_global
    from public.chain_usage
   where network = p_network and kind = p_kind
     and created_at > now() - p_window;

  if v_global >= p_global_limit then
    select u.created_at + p_window into v_freed
      from public.chain_usage u
     where u.network = p_network and u.kind = p_kind
       and u.created_at > now() - p_window
     order by u.created_at asc
    offset (v_global - p_global_limit)
     limit 1;
    return query select false, 'global'::text,
      greatest(1, ceil(extract(epoch from (v_freed - now())))::integer);
    return;
  end if;

  select count(*)::integer into v_user
    from public.chain_usage
   where user_id = p_user_id and network = p_network and kind = p_kind
     and created_at > now() - p_window;

  if v_user >= p_user_limit then
    select u.created_at + p_window into v_freed
      from public.chain_usage u
     where u.user_id = p_user_id and u.network = p_network and u.kind = p_kind
       and u.created_at > now() - p_window
     order by u.created_at asc
    offset (v_user - p_user_limit)
     limit 1;
    return query select false, 'user'::text,
      greatest(1, ceil(extract(epoch from (v_freed - now())))::integer);
    return;
  end if;

  insert into public.chain_usage (user_id, network, kind) values (p_user_id, p_network, p_kind);
  return query select true, null::text, 0;
end;
$$;

-- p_user_id is a parameter, so a signed-in user calling this over RPC could
-- spend someone else's budget. Only the service role (the relay) may call it.
revoke execute on function public.consume_chain_quota(uuid, text, text, integer, integer, interval)
  from public, anon, authenticated;
grant execute on function public.consume_chain_quota(uuid, text, text, integer, integer, interval)
  to service_role;
