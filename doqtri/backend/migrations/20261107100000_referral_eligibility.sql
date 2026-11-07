-- Counting referred users' on-chain activity and marking referrals eligible
-- (WP-4.6, DOQ-23, D-109, D-110).
--
-- A referral earns a reward once the referred user has reached a number of
-- activities: successful calls to a Doqtri contract by one of their wallets,
-- at or after the referral was recorded. No existing record holds them all:
-- chain_writes has only passkey note writes, chain_usage is charged before
-- submission, and testnet, where production runs, resets now and then. So
-- activity is stored here, and eligibility never reverses once reached.
--
-- The rules (threshold, reward, default limit) live in
-- doqtri/frontend/lib/referral-program.ts and arrive as function arguments;
-- nothing here repeats them.
--
--   referral_chain_activity   one row per (network, tx_hash): a transaction
--                             seen twice counts once. Filled by the relay for
--                             passkey wallets, by the chain-jobs run from
--                             Horizon for wallet logins, and by the sweep of
--                             chain_writes below. Goes with the referred user.
--
--   referral_rewards          one row per qualified referral, with the amount
--                             it was worth then. eligible | over_limit | paid
--                             | void. Both users are `on delete set null`, so
--                             the row outlives either as the accounting record
--                             and no row names a deleted account (the scan in
--                             backend/tests/account_anonymisation.test.sql):
--                               referred user deleted  the reward stays as it
--                                                      was, shown as Former user
--                               referrer deleted       unpaid rewards are void
--                                                      (referrer_deleted, the
--                                                      trigger below); paid
--                                                      ones stay
--                             One reward per wallet per network: the partial
--                             unique index holds the wallet for every reward,
--                             a voided one too, so deleting an account and
--                             signing up again earns nothing. The second
--                             account's row is void with duplicate_wallet, the
--                             one reason that holds no wallet, so that it can
--                             exist beside the reward it duplicates.
--
--   referral_reward_limits    a referrer's limit, where an admin changed the
--                             default (DOQ-26). The limit is per referrer, not
--                             per network. The first to qualify count; later
--                             ones are over_limit and move up, oldest first,
--                             when a place opens. Lowering a limit demotes
--                             nothing.
--
--   referral_activity_sync    when each referred user was last synced, only so
--                             that the sync takes turns fairly. It is no
--                             Horizon cursor: the sync reads newest-first and
--                             keeps no position, which survives testnet resets.
--
-- Qualifying and promoting serialize per referrer on an advisory lock, so
-- concurrent qualifications can't pass the limit. The unique indexes stop two
-- rewards for one referral or one wallet; two referrers' users on one wallet
-- at the same moment hold different locks, so the later insert does nothing
-- and its user is marked duplicate on their next sync.
--
-- Pending and failed writes don't count: the relay records only confirmed
-- ones, and the sweep reads only confirmed chain_writes, so a pending write
-- counts once lib/stellar/pending-writes.ts has confirmed it. Wallet
-- deployments and passkey changes are not calls to a Doqtri contract and are
-- never recorded. This reads chain_writes.status, so
-- 20261101110000_chain_writes_status.sql must be applied first.
--
-- Backfill: existing referred users' confirmed chain_writes become activity,
-- only from when each referral was recorded. No rewards are created here, as
-- this file doesn't know the threshold; the first sync run qualifies them.
--
-- The functions run as their caller, the service role, which can read every
-- table they touch, so none is security definer. RLS on with no policies, and
-- every privilege revoked from anon and authenticated: only the service role
-- reads or writes these tables. DOQ-24 and DOQ-26 will expose them through
-- server routes, so the note in 20261018000000_create_referrals.sql that
-- referrals are only ever shown as counts stops being true there.

create table public.referral_chain_activity (
  network     text not null check (network in ('testnet', 'mainnet')),
  tx_hash     text not null check (tx_hash ~ '^[0-9a-f]{64}$'),
  user_id     uuid not null references auth.users(id) on delete cascade,
  wallet      text not null check (wallet ~ '^[GC][A-Z2-7]{55}$'),
  fn          text not null,
  occurred_at timestamptz not null,
  primary key (network, tx_hash)
);

create index referral_chain_activity_user_idx
  on public.referral_chain_activity (user_id, network);

comment on table public.referral_chain_activity is
  'Each referred user''s successful calls to Doqtri contracts since their referral (DOQ-23). Stored because testnet resets. Service role only.';

create table public.referral_rewards (
  id               uuid primary key default gen_random_uuid(),
  network          text not null check (network in ('testnet', 'mainnet')),
  referrer_user_id uuid references auth.users(id) on delete set null,
  referred_user_id uuid unique references auth.users(id) on delete set null,
  referred_wallet  text not null check (referred_wallet ~ '^[GC][A-Z2-7]{55}$'),
  amount_php       integer not null check (amount_php > 0),
  status           text not null check (status in ('eligible', 'over_limit', 'paid', 'void')),
  void_reason      text,
  qualified_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint referral_rewards_void_reason_check check ((status = 'void') = (void_reason is not null))
);

create unique index referral_rewards_wallet_idx
  on public.referral_rewards (network, referred_wallet)
  where void_reason is distinct from 'duplicate_wallet';
create index referral_rewards_referrer_idx
  on public.referral_rewards (referrer_user_id, status, qualified_at);

comment on table public.referral_rewards is
  'One row per qualified referral (DOQ-23). Outlives both users as the accounting record. Service role only.';
comment on column public.referral_rewards.void_reason is
  'Why a void reward is void. duplicate_wallet alone holds no wallet in referral_rewards_wallet_idx.';

create table public.referral_reward_limits (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  reward_limit integer not null check (reward_limit >= 0),
  updated_at   timestamptz not null default now()
);

comment on table public.referral_reward_limits is
  'A referrer''s reward limit where it differs from the default in lib/referral-program.ts (DOQ-23, DOQ-26). Service role only.';

create table public.referral_activity_sync (
  referred_user_id uuid primary key references auth.users(id) on delete cascade,
  synced_at        timestamptz not null default now()
);

comment on table public.referral_activity_sync is
  'When the chain-jobs run last synced each referred user, only so that it takes turns fairly (DOQ-23). Service role only.';

-- The sweep finds a user's chain_writes by the wallet that signed them.
create index chain_writes_owner_idx on public.chain_writes (network, owner);

alter table public.referral_chain_activity enable row level security;
alter table public.referral_rewards enable row level security;
alter table public.referral_reward_limits enable row level security;
alter table public.referral_activity_sync enable row level security;

-- ---------------------------------------------------------------------------
-- The rewards' own rules
-- ---------------------------------------------------------------------------

-- Deleting a referrer sets referrer_user_id to null through the foreign key,
-- which fires this. Paid rewards stay, as the accounting record. Deleting the
-- referred user changes nothing else on the row.
create function public.referral_rewards_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.referrer_user_id is null and old.referrer_user_id is not null
     and new.status in ('eligible', 'over_limit') then
    new.status := 'void';
    new.void_reason := 'referrer_deleted';
  end if;
  return new;
end;
$$;

create trigger referral_rewards_before_update
  before update on public.referral_rewards
  for each row execute function public.referral_rewards_before_update();

-- Everything that decides a referrer's places takes this first. Held until the
-- transaction ends. Each function records activity before taking it and writes
-- none after, so two callers can't deadlock over a transaction they both saw.
create function public.lock_referral_referrer(p_referrer uuid)
returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('referral_rewards:' || p_referrer::text, 0));
$$;

-- How many more rewards a referrer can have eligible; 0 or less when none.
-- Paid ones keep their place. Call it holding the referrer's lock.
create function public.referral_places_left(p_referrer uuid, p_default_limit integer)
returns integer
language sql
set search_path = ''
as $$
  select coalesce((select l.reward_limit from public.referral_reward_limits l where l.user_id = p_referrer),
                  p_default_limit)
       - (select count(*)::integer from public.referral_rewards w
           where w.referrer_user_id = p_referrer and w.status in ('eligible', 'paid'));
$$;

-- Moves the oldest over_limit rewards up while the referrer has places.
create function public.promote_referral_rewards(p_referrer uuid, p_default_limit integer)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_places integer;
begin
  perform public.lock_referral_referrer(p_referrer);
  v_places := public.referral_places_left(p_referrer, p_default_limit);
  if v_places <= 0 then
    return;
  end if;
  update public.referral_rewards w
     set status = 'eligible'
   where w.id in (
     select o.id from public.referral_rewards o
      where o.referrer_user_id = p_referrer and o.status = 'over_limit'
      order by o.qualified_at, o.id
      limit v_places
   );
end;
$$;

-- ---------------------------------------------------------------------------
-- Activity into rewards
-- ---------------------------------------------------------------------------

-- A referred user's confirmed chain_writes for their smart wallet, from when
-- the referral was recorded, as activity. In a fixed order, so overlapping
-- sweeps can't deadlock on each other's rows.
create function public.sweep_referral_chain_writes(p_user_id uuid, p_network text)
returns void
language sql
set search_path = ''
as $$
  insert into public.referral_chain_activity (network, tx_hash, user_id, wallet, fn, occurred_at)
  select c.network, c.tx_hash, r.referred_user_id, c.owner, c.fn, c.created_at
    from public.referrals r
    join public.smart_wallets s on s.user_id = r.referred_user_id and s.network = p_network
    join public.chain_writes c on c.network = s.network and c.owner = s.address
   where r.referred_user_id = p_user_id
     and c.status = 'confirmed'
     and c.created_at >= r.created_at
   order by c.tx_hash
  on conflict (network, tx_hash) do nothing;
$$;

-- Gives a referred user their reward once they have reached the threshold.
-- Does nothing if they have one: eligibility never reverses, and it is stored,
-- so nothing here depends on the ledger still holding the activity. Inserts
-- `on conflict do nothing`, because another referrer's user can take the same
-- wallet without holding this lock (see the header).
create function public.qualify_referral(
  p_user_id uuid,
  p_network text,
  p_threshold integer,
  p_reward_php integer,
  p_default_limit integer
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_referrer uuid;
  v_wallet   text;
begin
  select r.referrer_user_id into v_referrer
    from public.referrals r where r.referred_user_id = p_user_id;
  if v_referrer is null then
    return;
  end if;

  perform public.lock_referral_referrer(v_referrer);

  if exists (select 1 from public.referral_rewards w where w.referred_user_id = p_user_id) then
    return;
  end if;
  if (select count(*) from public.referral_chain_activity a
       where a.user_id = p_user_id and a.network = p_network) < p_threshold then
    return;
  end if;

  -- A wallet they used has already earned on this network.
  select a.wallet into v_wallet
    from public.referral_chain_activity a
   where a.user_id = p_user_id and a.network = p_network
     and exists (select 1 from public.referral_rewards w
                  where w.network = p_network and w.referred_wallet = a.wallet
                    and w.void_reason is distinct from 'duplicate_wallet')
   order by a.occurred_at desc, a.tx_hash
   limit 1;
  if v_wallet is not null then
    insert into public.referral_rewards
      (network, referrer_user_id, referred_user_id, referred_wallet, amount_php, status, void_reason)
    values (p_network, v_referrer, p_user_id, v_wallet, p_reward_php, 'void', 'duplicate_wallet')
    on conflict do nothing;
    return;
  end if;

  -- The wallet that reached the threshold.
  select a.wallet into v_wallet
    from public.referral_chain_activity a
   where a.user_id = p_user_id and a.network = p_network
   order by a.occurred_at desc, a.tx_hash
   limit 1;

  insert into public.referral_rewards
    (network, referrer_user_id, referred_user_id, referred_wallet, amount_php, status)
  values (
    p_network, v_referrer, p_user_id, v_wallet, p_reward_php,
    case when public.referral_places_left(v_referrer, p_default_limit) > 0 then 'eligible' else 'over_limit' end
  )
  on conflict do nothing;
end;
$$;

-- One confirmed call to a Doqtri contract. A no-op for a user with no referral
-- and for a call from before the referral was recorded.
create function public.record_referral_activity(
  p_user_id uuid,
  p_network text,
  p_tx_hash text,
  p_wallet text,
  p_fn text,
  p_occurred_at timestamptz,
  p_threshold integer,
  p_reward_php integer,
  p_default_limit integer
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_referred_at timestamptz;
begin
  select r.created_at into v_referred_at
    from public.referrals r where r.referred_user_id = p_user_id;
  if v_referred_at is null or p_occurred_at < v_referred_at then
    return;
  end if;

  insert into public.referral_chain_activity (network, tx_hash, user_id, wallet, fn, occurred_at)
  values (p_network, p_tx_hash, p_user_id, p_wallet, p_fn, p_occurred_at)
  on conflict (network, tx_hash) do nothing;

  perform public.qualify_referral(p_user_id, p_network, p_threshold, p_reward_php, p_default_limit);
end;
$$;

-- One user's turn in the chain-jobs run: the sweep, so that a pending write
-- that has since confirmed counts and a failed recording is repaired, then
-- qualifying, which is also what gives backfilled users their reward.
create function public.settle_referral_activity(
  p_user_id uuid,
  p_network text,
  p_threshold integer,
  p_reward_php integer,
  p_default_limit integer
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.referrals r where r.referred_user_id = p_user_id) then
    return;
  end if;
  perform public.sweep_referral_chain_writes(p_user_id, p_network);
  perform public.qualify_referral(p_user_id, p_network, p_threshold, p_reward_php, p_default_limit);
  insert into public.referral_activity_sync (referred_user_id, synced_at)
  values (p_user_id, now())
  on conflict (referred_user_id) do update set synced_at = excluded.synced_at;
end;
$$;

-- The referred users still without a reward, least recently synced first.
create function public.referral_sync_candidates(p_network text, p_limit integer)
returns table (user_id uuid, referred_at timestamptz, c_wallet text, g_wallet text)
language sql
set search_path = ''
as $$
  select r.referred_user_id, r.created_at, s.address, a.address
    from public.referrals r
    left join public.smart_wallets s on s.user_id = r.referred_user_id and s.network = p_network
    left join public.wallet_accounts a on a.user_id = r.referred_user_id
    left join public.referral_activity_sync y on y.referred_user_id = r.referred_user_id
   where not exists (select 1 from public.referral_rewards w where w.referred_user_id = r.referred_user_id)
   order by y.synced_at asc nulls first, r.created_at, r.referred_user_id
   limit p_limit;
$$;

-- ---------------------------------------------------------------------------
-- What an admin does (DOQ-26)
-- ---------------------------------------------------------------------------

-- Voids an unpaid reward and opens its place. False when there is no such
-- reward or it can't be voided: a paid reward never can. The reason is
-- required, and can't be duplicate_wallet, which would let the wallet earn
-- again.
create function public.void_referral_reward(p_reward_id uuid, p_reason text, p_default_limit integer)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_referrer uuid;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Voiding a reward needs a reason.' using errcode = '22023';
  end if;
  if p_reason = 'duplicate_wallet' then
    raise exception 'duplicate_wallet is only for a wallet that has already earned.' using errcode = '22023';
  end if;

  select w.referrer_user_id into v_referrer from public.referral_rewards w where w.id = p_reward_id;
  if v_referrer is null then
    return false;
  end if;

  -- Before the update: promoting under the lock can reach this row.
  perform public.lock_referral_referrer(v_referrer);

  update public.referral_rewards w
     set status = 'void', void_reason = p_reason
   where w.id = p_reward_id and w.status in ('eligible', 'over_limit');
  if not found then
    return false;
  end if;

  perform public.promote_referral_rewards(v_referrer, p_default_limit);
  return true;
end;
$$;

-- Sets a referrer's limit. Raising it moves over_limit rewards up; lowering it
-- demotes nothing.
create function public.set_referral_reward_limit(p_user_id uuid, p_limit integer, p_default_limit integer)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform public.lock_referral_referrer(p_user_id);
  insert into public.referral_reward_limits (user_id, reward_limit)
  values (p_user_id, p_limit)
  on conflict (user_id) do update set reward_limit = excluded.reward_limit, updated_at = now();
  perform public.promote_referral_rewards(p_user_id, p_default_limit);
end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

select public.sweep_referral_chain_writes(r.referred_user_id, s.network)
  from public.referrals r
  join public.smart_wallets s on s.user_id = r.referred_user_id;

-- ---------------------------------------------------------------------------
-- Service role only
-- ---------------------------------------------------------------------------

revoke all on public.referral_chain_activity, public.referral_rewards,
              public.referral_reward_limits, public.referral_activity_sync
  from public, anon, authenticated;
grant select, insert, update, delete
  on public.referral_chain_activity, public.referral_rewards,
     public.referral_reward_limits, public.referral_activity_sync
  to service_role;

revoke execute on function public.referral_rewards_before_update() from public, anon, authenticated;

revoke execute on function
  public.lock_referral_referrer(uuid),
  public.referral_places_left(uuid, integer),
  public.promote_referral_rewards(uuid, integer),
  public.sweep_referral_chain_writes(uuid, text),
  public.qualify_referral(uuid, text, integer, integer, integer),
  public.record_referral_activity(uuid, text, text, text, text, timestamptz, integer, integer, integer),
  public.settle_referral_activity(uuid, text, integer, integer, integer),
  public.referral_sync_candidates(text, integer),
  public.void_referral_reward(uuid, text, integer),
  public.set_referral_reward_limit(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function
  public.lock_referral_referrer(uuid),
  public.referral_places_left(uuid, integer),
  public.promote_referral_rewards(uuid, integer),
  public.sweep_referral_chain_writes(uuid, text),
  public.qualify_referral(uuid, text, integer, integer, integer),
  public.record_referral_activity(uuid, text, text, text, text, timestamptz, integer, integer, integer),
  public.settle_referral_activity(uuid, text, integer, integer, integer),
  public.referral_sync_candidates(text, integer),
  public.void_referral_reward(uuid, text, integer),
  public.set_referral_reward_limit(uuid, integer, integer)
  to service_role;
