-- A leased pool of channel accounts for user-paid writes (WP-4.1, DOQ-3).
--
-- submitPaidWrite (doqtri/frontend/lib/stellar/direct-submit.ts) builds every
-- forwarded write with Doqtri's relayer as the transaction source. Stellar
-- takes one pending transaction per source account, so about one paid write
-- lands per ledger and the rest fail with txBadSeq or TRY_AGAIN_LATER. The
-- fix gives each write its own source: one of a pool of channel accounts,
-- leased for the length of the write. The relayer still signs its own
-- forward() approval (address credentials) and still receives fee_amount;
-- each channel account pays its own network fee.
--
--   relay_channels   one row per channel account: which network it is on,
--                    its public key, and its lease. Service role only.
--
-- Secrets never come here. A channel's keypair is derived on the server from
-- RELAY_CHANNEL_SEED and the row's idx (channelKeypair in
-- doqtri/frontend/lib/stellar/channel-accounts.mjs), so the table holds
-- public keys and lease state only. scripts/seed-relay-channels.mjs creates and
-- funds the accounts and writes these rows.
--
-- Leasing. lease_relay_channel() claims the free row whose lease ended
-- longest ago with `for update skip locked`, so two requests leasing at the
-- same moment never get the same account: the second skips the row the
-- first has locked and takes the next one. A lease is free once
-- leased_until has passed, so a server that died mid-write gives its
-- account back by itself.
--
-- The lease outlives the transaction. Every paid write is built with a 60 s
-- time bound (setTimeout(60) in direct-submit.ts), so once a lease runs out
-- the transaction it covered has either landed or can no longer land, and
-- the next holder cannot race it for the account's sequence number. The
-- default TTL is 90 s, and a TTL of 60 s or less is refused.
--
-- next_seq is the sequence number the channel's next transaction carries,
-- as the last holder saw it. An RPC node that lags a ledger behind would
-- hand out a sequence number already used; the stored value is the floor.
-- release_relay_channel() writes it back only while the caller still holds
-- the lease (same lease_id), so a holder whose lease expired and was taken
-- by someone else changes nothing.
--
-- idx is the table's key on its own, as each deployment's database serves
-- one network; network is still stored and matched, so a row seeded for the
-- other network is never leased.

create table public.relay_channels (
  -- With RELAY_CHANNEL_SEED, derives the channel's keypair.
  idx          integer primary key check (idx >= 0),
  network      text not null check (network in ('testnet', 'mainnet')),
  public_key   text not null unique check (public_key ~ '^G[A-Z2-7]{55}$'),
  -- Null or past: free.
  leased_until timestamptz,
  -- Who holds (or last held) the lease; release matches on it.
  lease_id     uuid,
  -- The sequence number the channel's next transaction carries, as last seen.
  next_seq     bigint check (next_seq >= 0),
  check ((leased_until is null) = (lease_id is null))
);

comment on table public.relay_channels is
  'Channel accounts that source user-paid writes, one lease each (WP-4.1). Public keys only: keypairs are derived from RELAY_CHANNEL_SEED and idx on the server. Service role only.';
comment on column public.relay_channels.next_seq is
  'The sequence number the channel''s next transaction carries, as the last lease holder saw it: a floor under a lagging RPC read.';

alter table public.relay_channels enable row level security;

-- No policy, and no privilege either: only the relay route (service role)
-- leases and releases, and only the seed script writes rows.
revoke all on table public.relay_channels from public, anon, authenticated;
grant select, insert, update, delete on table public.relay_channels to service_role;


-- ---------------------------------------------------------------------------
-- Leasing and releasing
-- ---------------------------------------------------------------------------

-- Claims one free channel on p_network for p_ttl, or returns no row when
-- all are leased (the caller waits and asks again). Returns the public key
-- too, so the server can check it derives the same one from its seed before
-- it signs with it. next_seq comes back as text: sequence numbers run past
-- 2^53, and PostgREST would send a bigint as a JSON number, which JavaScript
-- rounds. Security invoker: only the service role may call it, and it
-- already holds the table.
create function public.lease_relay_channel(p_network text, p_ttl interval default interval '90 seconds')
returns table (idx integer, lease_id uuid, next_seq text, public_key text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
begin
  -- Longer than the transaction's 60 s time bound (see the header).
  if p_ttl is null or p_ttl <= interval '60 seconds' then
    raise exception 'a relay channel lease must outlive the 60 s transaction timeout, got %', p_ttl
      using errcode = '22023';
  end if;

  return query
  update public.relay_channels c
     set leased_until = now() + p_ttl,
         lease_id = gen_random_uuid()
   where c.idx = (
     select f.idx from public.relay_channels f
      where f.network = p_network
        and (f.leased_until is null or f.leased_until < now())
      order by f.leased_until nulls first, f.idx
      limit 1
        for update skip locked
   )
  returning c.idx, c.lease_id, c.next_seq::text, c.public_key;
end;
$$;

-- Gives a lease back and records the channel's next sequence number, only
-- while p_lease_id still holds it. True when it did; false when the lease
-- had already passed to someone else (nothing changes then). A null
-- p_next_seq keeps the stored one, and the stored one never goes down: the
-- chain's sequence numbers only climb.
create function public.release_relay_channel(p_idx integer, p_lease_id uuid, p_next_seq bigint)
returns boolean
language sql
set search_path = ''
as $$
  with released as (
    update public.relay_channels c
       set leased_until = null,
           lease_id = null,
           next_seq = greatest(c.next_seq, p_next_seq)
     where c.idx = p_idx
       and c.lease_id = p_lease_id
    returning 1
  )
  select exists (select 1 from released);
$$;

revoke execute on function public.lease_relay_channel(text, interval) from public, anon, authenticated;
grant execute on function public.lease_relay_channel(text, interval) to service_role;
revoke execute on function public.release_relay_channel(integer, uuid, bigint) from public, anon, authenticated;
grant execute on function public.release_relay_channel(integer, uuid, bigint) to service_role;
