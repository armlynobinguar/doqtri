-- Paying referral rewards by hand, from the admin payouts panel (WP-4.6, DOQ-26,
-- D-110, D-112).
--
-- Admins read the queue at /admin/referrals/payouts, send each payout themselves
-- (nothing here or in the app transfers anything), and record it here. Money
-- leaves by hand before anything can be recorded, so a payout has two steps, and
-- the database decides at the first one, before any money moves:
--
--   start_referral_payout()  under the referrer's lock, claims exactly the rewards,
--                            total and details version the admin saw, for that
--                            admin, for 2 hours, and returns the details as they
--                            are now. Refused if anything differs, or while
--                            another admin holds a live claim on the referrer.
--                            The admin sends the money only after this.
--   mark_referral_rewards_paid()
--                            records the payout. Needs a live claim by the same
--                            admin for the same rewards, total and version, and
--                            clears it. release_referral_payout() clears it
--                            without paying.
--
-- So a second admin, or a tab left open, can't start a payout someone is making,
-- and can't record one already recorded: the second is told who paid and when
-- (referral_payout_conflict()), so whoever has already sent money knows to
-- reconcile. What this adds:
--
--   referral_payouts        the ledger: one row per payout an admin recorded, with
--                           its amount, how many rewards, the method (and the
--                           e-wallet provider), an optional reference (a
--                           transaction hash or an e-wallet reference number),
--                           when, and which admin. No copy of the address,
--                           account number, name or memo: those stay only in
--                           referral_payout_profiles. Both users are `on delete
--                           set null`, so the row outlives either as the
--                           accounting record and names no deleted account (the
--                           scan in backend/tests/account_anonymisation.test.sql).
--                           RLS on with no policies; the service role may only
--                           read it. Only mark_referral_rewards_paid() writes here,
--                           and nothing deletes a row (a trigger refuses).
--
--   referral_payout_claims  who is paying whom right now: one live row per
--                           referrer at most, expiring after 2 hours. Goes with
--                           either account (on delete cascade). Service role read
--                           only; written by the functions above.
--
--   referral_rewards        gains payout_id, set exactly when a reward is paid.
--     .payout_id
--
--   referral_payout_         gains created_at, when the details were first saved,
--     profiles.created_at    backfilled from updated_at. A trigger keeps it on every
--                           update, so an edit can't move a payout's due date,
--                           which counts from it (DOQ-29's 30 days), and sets
--                           updated_at itself, so the details' version changes
--                           with every edit whatever the writer sends.
--
--   paid is final           a trigger on referral_rewards: a paid reward's status,
--                           amount, payout, network, wallet and qualifying time
--                           never change, and its users can only become null (the
--                           two account deletions' set null). A reward becomes
--                           paid only from eligible, only inside
--                           mark_referral_rewards_paid(), which sets a
--                           transaction-local flag around its one update, and
--                           never on insert. A paid reward can't be deleted
--                           either: it holds its wallet in referral_rewards_wallet_idx,
--                           and the ledger row points at it. No account deletion
--                           deletes a reward (both its users are set null), so
--                           nothing legitimate needs to.
--
--   restore_referral_reward()
--                           a void reward back to eligible if the referrer has a
--                           place, else over_limit, under the lock. Never one void
--                           as duplicate_wallet (its wallet has already earned) or
--                           referrer_deleted (no one to pay).
--
--   referral_payout_queue(), referral_payout_referrals(), referral_payout_conflict()
--                           what the panel reads: per referrer with something to
--                           act on (with any live claim and who holds it), per
--                           referred account for review, and who paid or is
--                           paying when a step is refused. Security definer to
--                           read auth.users' emails, which the service role can't
--                           select, as referral_dashboard() does, so each is one
--                           query and not one Auth call per row. Activity counts
--                           follow qualify_referral(): the reward's network, or
--                           the app's when there's none yet, from when the
--                           referral was recorded.
--
-- Voiding and limits reuse void_referral_reward() and set_referral_reward_limit()
-- from 20261107100000_referral_eligibility.sql, which also promote the oldest
-- over-limit rewards when a place opens. The rules (default limit, threshold,
-- reward) stay in doqtri/frontend/lib/referral-program.ts and arrive as arguments.
--
-- Account deletion and the lock: a referrer's deletion locks their auth.users row
-- and then cascades, without the advisory lock (see 20261107100000's header).
-- Both payout steps take the advisory lock and then, before touching any other
-- row, insert a row whose foreign keys name the referrer and the admin: the claim
-- or the ledger row. The foreign key check takes a key share on those auth.users
-- rows as their table's owner, so no extra privilege on auth.users is needed, and
-- whichever gets the account row first goes first: the two can't deadlock. A step
-- that waited behind a deletion fails its foreign key check and is refused, and a
-- refusal rolls the inserted row back.
--
-- Errors carry SQLSTATEs of their own, which the routes turn into fixed text:
--   DQR01  paid is final, or paying outside mark_referral_rewards_paid()
--   DQR02  the rewards changed since the admin looked (or the referrer is gone)
--   DQR03  the referrer has no payout details
--   DQR04  the payout details changed since the admin looked
--   DQR05  this void reward can't be restored
--   DQR06  the admin's own account is gone
--   DQR07  another admin holds a live claim on this referrer
--   DQR08  no live claim by this admin for exactly these rewards, total and details
--   22023  an argument is missing or malformed

-- ---------------------------------------------------------------------------
-- When the payout details were first saved, and their version
-- ---------------------------------------------------------------------------

alter table public.referral_payout_profiles add column created_at timestamptz;
-- Exact only because DOQ-25 and DOQ-26 ship together: no profile has been edited before this runs.
update public.referral_payout_profiles set created_at = updated_at;
alter table public.referral_payout_profiles
  alter column created_at set default now(),
  alter column created_at set not null;

comment on column public.referral_payout_profiles.created_at is
  'When the details were first saved. Never changes on an edit: a payout is due 30 days from it or the reward, whichever is later (DOQ-26).';
comment on column public.referral_payout_profiles.updated_at is
  'The details'' version: set by the database on every update, whatever the writer sends (DOQ-26).';

create function public.referral_payout_profiles_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := old.created_at;
  -- clock_timestamp(), not now(): two edits in one transaction are two versions.
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger referral_payout_profiles_before_update
  before update on public.referral_payout_profiles
  for each row execute function public.referral_payout_profiles_before_update();

-- ---------------------------------------------------------------------------
-- The ledger, and who is paying now
-- ---------------------------------------------------------------------------

create table public.referral_payouts (
  id               uuid primary key default gen_random_uuid(),
  referrer_user_id uuid references auth.users(id) on delete set null,
  paid_by          uuid references auth.users(id) on delete set null,
  amount_php       integer not null check (amount_php > 0),
  reward_count     integer not null check (reward_count > 0),
  method           text not null check (method in ('xlm', 'ewallet')),
  ewallet_provider text check (ewallet_provider in ('GCash', 'Maya', 'Bank', 'Other')),
  reference        text check (
    char_length(reference) between 1 and 100 and public.referral_payout_text_ok(reference)),
  paid_at          timestamptz not null default now(),
  constraint referral_payouts_provider check ((method = 'ewallet') = (ewallet_provider is not null))
);

create index referral_payouts_referrer_idx on public.referral_payouts (referrer_user_id, paid_at);

comment on table public.referral_payouts is
  'One row per payout an admin recorded by hand (DOQ-26). No address or account number. Outlives both users, and is never deleted. Written only by mark_referral_rewards_paid().';
comment on column public.referral_payouts.paid_by is
  'The admin who recorded the payout; null once that account is deleted.';
comment on column public.referral_payouts.reference is
  'Optional: the transaction hash for XLM, or the e-wallet reference number.';

alter table public.referral_payouts enable row level security;

create function public.referral_payouts_keep()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'A payout is the accounting record and can''t be deleted.' using errcode = 'DQR01';
end;
$$;

create trigger referral_payouts_keep
  before delete on public.referral_payouts
  for each row execute function public.referral_payouts_keep();

create table public.referral_payout_claims (
  id                 uuid primary key default gen_random_uuid(),
  referrer_user_id   uuid not null references auth.users(id) on delete cascade,
  claimed_by         uuid not null references auth.users(id) on delete cascade,
  reward_ids         uuid[] not null check (cardinality(reward_ids) > 0),
  amount_php         integer not null check (amount_php > 0),
  details_updated_at timestamptz not null,
  claimed_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  constraint referral_payout_claims_expiry check (expires_at > claimed_at)
);

create index referral_payout_claims_referrer_idx on public.referral_payout_claims (referrer_user_id, expires_at);
create index referral_payout_claims_admin_idx on public.referral_payout_claims (claimed_by);

comment on table public.referral_payout_claims is
  'An admin paying a referrer right now: the rewards, total and details version they started with, for 2 hours (DOQ-26). Written only by the payout functions.';

alter table public.referral_payout_claims enable row level security;

alter table public.referral_rewards add column payout_id uuid references public.referral_payouts(id);
alter table public.referral_rewards
  add constraint referral_rewards_payout_check check ((status = 'paid') = (payout_id is not null));
create index referral_rewards_payout_idx on public.referral_rewards (payout_id) where payout_id is not null;

comment on column public.referral_rewards.payout_id is
  'The payout that paid this reward: set exactly when status is paid (DOQ-26).';

-- ---------------------------------------------------------------------------
-- Paid is final
-- ---------------------------------------------------------------------------

-- Fires after referral_rewards_before_update (triggers run in name order), so it
-- sees the referrer deletion's void, which never touches a paid reward.
create function public.referral_rewards_paid_final()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'paid' then
      raise exception 'A paid reward is the accounting record and can''t be deleted.' using errcode = 'DQR01';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'paid' or new.payout_id is not null then
      raise exception 'A reward is paid only by mark_referral_rewards_paid().' using errcode = 'DQR01';
    end if;
    return new;
  end if;

  if old.status = 'paid' then
    if new.status is distinct from old.status
       or new.amount_php is distinct from old.amount_php
       or new.payout_id is distinct from old.payout_id
       or new.network is distinct from old.network
       or new.referred_wallet is distinct from old.referred_wallet
       or new.qualified_at is distinct from old.qualified_at
       or new.void_reason is distinct from old.void_reason
       or (new.referrer_user_id is distinct from old.referrer_user_id and new.referrer_user_id is not null)
       or (new.referred_user_id is distinct from old.referred_user_id and new.referred_user_id is not null) then
      raise exception 'A paid reward is final.' using errcode = 'DQR01';
    end if;
    return new;
  end if;

  if new.status = 'paid' or new.payout_id is not null then
    if old.status <> 'eligible' then
      raise exception 'Only an eligible reward can be paid.' using errcode = 'DQR01';
    end if;
    if coalesce(current_setting('doqtri.paying_referral_rewards', true), '') <> 'on' then
      raise exception 'A reward is paid only by mark_referral_rewards_paid().' using errcode = 'DQR01';
    end if;
  end if;
  return new;
end;
$$;

create trigger referral_rewards_paid_final
  before insert or update or delete on public.referral_rewards
  for each row execute function public.referral_rewards_paid_final();

-- ---------------------------------------------------------------------------
-- Paying, in two steps
-- ---------------------------------------------------------------------------

-- The arguments both steps share, checked before any lock.
create function public.referral_payout_check_request(
  p_referrer uuid,
  p_reward_ids uuid[],
  p_amount_php integer,
  p_details_updated_at timestamptz,
  p_admin uuid
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_referrer is null or p_admin is null then
    raise exception 'A payout needs its referrer and the admin making it.' using errcode = '22023';
  end if;
  if p_reward_ids is null or cardinality(p_reward_ids) = 0 or array_position(p_reward_ids, null) is not null
     or (select count(distinct x) from unnest(p_reward_ids) x) <> cardinality(p_reward_ids) then
    raise exception 'A payout needs the rewards it pays, each once.' using errcode = '22023';
  end if;
  if p_amount_php is null or p_amount_php <= 0 then
    raise exception 'A payout needs the amount the admin saw.' using errcode = '22023';
  end if;
  if p_details_updated_at is null then
    raise exception 'A payout needs the version of the details the admin saw.' using errcode = '22023';
  end if;
end;
$$;

-- Exactly p_reward_ids, all eligible, all p_referrer's, adding up to p_amount_php,
-- or DQR02. With p_lock, the rows stay locked until the transaction ends.
create function public.referral_payout_check_rewards(
  p_referrer uuid,
  p_reward_ids uuid[],
  p_amount_php integer,
  p_lock boolean
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
  v_total bigint;
begin
  if p_lock then
    select count(*)::integer, coalesce(sum(w.amount_php), 0) into v_count, v_total
      from (select r.amount_php from public.referral_rewards r
             where r.id = any(p_reward_ids) and r.referrer_user_id = p_referrer and r.status = 'eligible'
             order by r.id
               for update) w;
  else
    select count(*)::integer, coalesce(sum(r.amount_php), 0) into v_count, v_total
      from public.referral_rewards r
     where r.id = any(p_reward_ids) and r.referrer_user_id = p_referrer and r.status = 'eligible';
  end if;
  if v_count <> cardinality(p_reward_ids) or v_total <> p_amount_php then
    raise exception 'These rewards changed since they were shown.' using errcode = 'DQR02';
  end if;
end;
$$;

-- A foreign key refusal on the first insert: which account went.
create function public.referral_payout_account_gone(p_constraint text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_constraint in ('referral_payout_claims_claimed_by_fkey', 'referral_payouts_paid_by_fkey') then
    raise exception 'The admin''s account no longer exists.' using errcode = 'DQR06';
  end if;
  raise exception 'These rewards changed since they were shown.' using errcode = 'DQR02';
end;
$$;

-- Step one. Claims the payout for p_admin for 2 hours and returns the details as
-- they are now, which the admin sends to. p_admin comes from the admin's verified
-- session. Starting again replaces the admin's own claim, with a fresh 2 hours.
create function public.start_referral_payout(
  p_referrer uuid,
  p_reward_ids uuid[],
  p_amount_php integer,
  p_details_updated_at timestamptz,
  p_admin uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim      uuid;
  v_expires    timestamptz := now() + interval '2 hours';
  v_constraint text;
  v_profile    public.referral_payout_profiles%rowtype;
begin
  perform public.referral_payout_check_request(p_referrer, p_reward_ids, p_amount_php, p_details_updated_at, p_admin);
  perform public.lock_referral_referrer(p_referrer);

  -- First, before any other row: see the header.
  begin
    insert into public.referral_payout_claims
      (referrer_user_id, claimed_by, reward_ids, amount_php, details_updated_at, expires_at)
    values (p_referrer, p_admin, p_reward_ids, p_amount_php, p_details_updated_at, v_expires)
    returning id into v_claim;
  exception when foreign_key_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform public.referral_payout_account_gone(v_constraint);
  end;

  perform public.referral_payout_check_rewards(p_referrer, p_reward_ids, p_amount_php, false);

  if exists (select 1 from public.referral_payout_claims c
              where c.referrer_user_id = p_referrer and c.id <> v_claim
                and c.claimed_by <> p_admin and c.expires_at > now()) then
    raise exception 'Another admin is paying this referrer.' using errcode = 'DQR07';
  end if;
  -- The admin's own earlier claims, and anyone's that expired.
  delete from public.referral_payout_claims c where c.referrer_user_id = p_referrer and c.id <> v_claim;

  select * into v_profile from public.referral_payout_profiles p where p.user_id = p_referrer;
  if not found then
    raise exception 'This referrer has no payout details yet.' using errcode = 'DQR03';
  end if;
  if v_profile.updated_at is distinct from p_details_updated_at then
    raise exception 'The payout details changed since they were shown.' using errcode = 'DQR04';
  end if;

  return jsonb_build_object(
    'claimed_at', now(),
    'expires_at', v_expires,
    'method', v_profile.method,
    'name', v_profile.name,
    'xlm_address', v_profile.xlm_address,
    'xlm_memo', v_profile.xlm_memo,
    'xlm_memo_type', v_profile.xlm_memo_type,
    'ewallet_provider', v_profile.ewallet_provider,
    'ewallet_account_name', v_profile.ewallet_account_name,
    'ewallet_account_number', v_profile.ewallet_account_number,
    'ewallet_details', v_profile.ewallet_details,
    'details_created_at', v_profile.created_at,
    'details_updated_at', v_profile.updated_at
  );
end;
$$;

-- Gives up p_admin's live claim on p_referrer without paying. False when they
-- hold none.
create function public.release_referral_payout(p_referrer uuid, p_admin uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_referrer is null or p_admin is null then
    raise exception 'Releasing needs the referrer and the admin.' using errcode = '22023';
  end if;
  perform public.lock_referral_referrer(p_referrer);
  delete from public.referral_payout_claims c
   where c.referrer_user_id = p_referrer and c.claimed_by = p_admin and c.expires_at > now();
  return found;
end;
$$;

-- Step two. Records one payout of exactly p_reward_ids, worth p_amount_php in all,
-- to the details at p_details_updated_at, which p_paid_by claimed with
-- start_referral_payout() and still holds. Returns the payout's id and clears
-- the claim. Refusals, in the order they're checked: details missing (DQR03) or
-- changed (DQR04), the rewards no longer as claimed, already paid among them
-- (DQR02), then no matching live claim (DQR08).
create function public.mark_referral_rewards_paid(
  p_referrer uuid,
  p_reward_ids uuid[],
  p_amount_php integer,
  p_details_updated_at timestamptz,
  p_reference text,
  p_paid_by uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reference  text := nullif(regexp_replace(coalesce(p_reference, ''), '^\s+|\s+$', '', 'g'), '');
  v_method     text;
  v_provider   text;
  v_details_at timestamptz;
  v_constraint text;
  v_claim      uuid;
  v_payout     uuid;
begin
  perform public.referral_payout_check_request(p_referrer, p_reward_ids, p_amount_php, p_details_updated_at, p_paid_by);
  if v_reference is not null
     and (char_length(v_reference) > 100 or not public.referral_payout_text_ok(v_reference)) then
    raise exception 'A reference is at most 100 characters, with no line breaks or special characters.'
      using errcode = '22023';
  end if;

  perform public.lock_referral_referrer(p_referrer);

  -- Read, not locked: the ledger row needs the method before it can be written.
  select p.method, p.ewallet_provider into v_method, v_provider
    from public.referral_payout_profiles p where p.user_id = p_referrer;
  if not found then
    raise exception 'This referrer has no payout details yet.' using errcode = 'DQR03';
  end if;

  -- First, before locking any other row: see the header.
  begin
    insert into public.referral_payouts
      (referrer_user_id, paid_by, amount_php, reward_count, method, ewallet_provider, reference)
    values (p_referrer, p_paid_by, p_amount_php, cardinality(p_reward_ids), v_method,
            case when v_method = 'ewallet' then v_provider end, v_reference)
    returning id into v_payout;
  exception when foreign_key_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform public.referral_payout_account_gone(v_constraint);
  end;

  -- Held until the end, so the details can't change while the payout is recorded.
  select p.updated_at into v_details_at
    from public.referral_payout_profiles p
   where p.user_id = p_referrer and p.method = v_method
     for share;
  if not found or v_details_at is distinct from p_details_updated_at then
    raise exception 'The payout details changed since they were shown.' using errcode = 'DQR04';
  end if;

  perform public.referral_payout_check_rewards(p_referrer, p_reward_ids, p_amount_php, true);

  select c.id into v_claim
    from public.referral_payout_claims c
   where c.referrer_user_id = p_referrer and c.claimed_by = p_paid_by and c.expires_at > now()
     and c.amount_php = p_amount_php and c.details_updated_at = p_details_updated_at
     and c.reward_ids @> p_reward_ids and c.reward_ids <@ p_reward_ids
     for update;
  if not found then
    raise exception 'No live claim by this admin for these rewards.' using errcode = 'DQR08';
  end if;

  perform set_config('doqtri.paying_referral_rewards', 'on', true);
  update public.referral_rewards r
     set status = 'paid', payout_id = v_payout
   where r.id = any(p_reward_ids);
  perform set_config('doqtri.paying_referral_rewards', '', true);

  delete from public.referral_payout_claims c where c.id = v_claim;
  return v_payout;
end;
$$;

-- ---------------------------------------------------------------------------
-- Restore
-- ---------------------------------------------------------------------------

-- A void reward back in the queue: eligible if the referrer has a place, else
-- over_limit. The new status, or null when there is no such void reward.
create function public.restore_referral_reward(p_reward_id uuid, p_default_limit integer)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_referrer uuid;
  v_status   text;
  v_reason   text;
  v_new      text;
begin
  select w.referrer_user_id, w.void_reason into v_referrer, v_reason
    from public.referral_rewards w where w.id = p_reward_id;
  if v_reason = 'referrer_deleted' then
    raise exception 'A reward whose referrer deleted their account can''t be restored.' using errcode = 'DQR05';
  end if;
  if v_referrer is null then
    return null;
  end if;

  perform public.lock_referral_referrer(v_referrer);

  select w.status, w.void_reason into v_status, v_reason
    from public.referral_rewards w
   where w.id = p_reward_id and w.referrer_user_id = v_referrer
     for update;
  if not found or v_status <> 'void' then
    return null;
  end if;
  if v_reason in ('duplicate_wallet', 'referrer_deleted') then
    raise exception 'This reward can''t be restored: %.', v_reason using errcode = 'DQR05';
  end if;

  v_new := case when public.referral_places_left(v_referrer, p_default_limit) > 0 then 'eligible' else 'over_limit' end;
  update public.referral_rewards w
     set status = v_new, void_reason = null
   where w.id = p_reward_id;
  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- What the panel reads
-- ---------------------------------------------------------------------------

-- One row per referrer with something to act on, on any network: an eligible or
-- over-limit reward, or a void one an admin can restore (not duplicate_wallet).
-- With the eligible rewards themselves (id, stored amount, when they qualified;
-- oldest first), the other counts, their limit where an admin set one, their
-- payout details in full, and the live claim on them, if any, with who holds it.
-- The app works out the amount owed and the due date.
create function public.referral_payout_queue()
returns table (
  referrer_user_id       uuid,
  email                  text,
  g_wallet               text,
  eligible_rewards       jsonb,
  over_limit_count       integer,
  paid_count             integer,
  void_count             integer,
  reward_limit           integer,
  method                 text,
  name                   text,
  xlm_address            text,
  xlm_memo               text,
  xlm_memo_type          text,
  ewallet_provider       text,
  ewallet_account_name   text,
  ewallet_account_number text,
  ewallet_details        text,
  details_created_at     timestamptz,
  details_updated_at     timestamptz,
  claim_admin_id         uuid,
  claim_admin_email      text,
  claim_admin_wallet     text,
  claimed_at             timestamptz,
  claim_expires_at       timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with q as (
    select w.referrer_user_id,
           u.email::text as email,
           a.address as g_wallet,
           coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'amount_php', w.amount_php, 'qualified_at', w.qualified_at)
                              order by w.qualified_at, w.id)
                      filter (where w.status = 'eligible'), '[]'::jsonb) as eligible_rewards,
           (count(*) filter (where w.status = 'over_limit'))::integer as over_limit_count,
           (count(*) filter (where w.status = 'paid'))::integer as paid_count,
           (count(*) filter (where w.status = 'void' and w.void_reason <> 'duplicate_wallet'))::integer as void_count,
           l.reward_limit,
           p.method, p.name, p.xlm_address, p.xlm_memo, p.xlm_memo_type,
           p.ewallet_provider, p.ewallet_account_name, p.ewallet_account_number, p.ewallet_details,
           p.created_at as details_created_at, p.updated_at as details_updated_at
      from public.referral_rewards w
      join auth.users u on u.id = w.referrer_user_id
      left join public.wallet_accounts a on a.user_id = w.referrer_user_id
      left join public.referral_reward_limits l on l.user_id = w.referrer_user_id
      left join public.referral_payout_profiles p on p.user_id = w.referrer_user_id
     group by w.referrer_user_id, u.id, a.address, l.user_id, p.user_id
    having count(*) filter (where w.status in ('eligible', 'over_limit')
                                or (w.status = 'void' and w.void_reason <> 'duplicate_wallet')) > 0
  )
  select q.*, c.claimed_by, cu.email::text, ca.address, c.claimed_at, c.expires_at
    from q
    left join lateral (
      select k.claimed_by, k.claimed_at, k.expires_at
        from public.referral_payout_claims k
       where k.referrer_user_id = q.referrer_user_id and k.expires_at > now()
       order by k.claimed_at desc
       limit 1
    ) c on true
    left join auth.users cu on cu.id = c.claimed_by
    left join public.wallet_accounts ca on ca.user_id = c.claimed_by
   order by q.referrer_user_id;
$$;

-- Every account p_referrer referred, in full, for an admin to review: who, when
-- they signed up and were referred, their activity in DOQ-23's window, and their
-- reward. A referred user who deleted their account comes back as their reward
-- alone, with former_user true. Newest first.
create function public.referral_payout_referrals(p_referrer uuid, p_network text)
returns table (
  reward_id       uuid,
  email           text,
  g_wallet        text,
  c_wallet        text,
  referred_wallet text,
  signed_up_at    timestamptz,
  referred_at     timestamptz,
  source          text,
  network         text,
  activity_count  integer,
  qualified_at    timestamptz,
  reward_status   text,
  void_reason     text,
  amount_php      integer,
  former_user     boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select x.reward_id, x.email, x.g_wallet, x.c_wallet, x.referred_wallet, x.signed_up_at, x.referred_at,
         x.source, x.network, x.activity_count, x.qualified_at, x.reward_status, x.void_reason, x.amount_php,
         x.former_user
    from (
      select w.id as reward_id,
             u.email::text as email,
             a.address as g_wallet,
             s.address as c_wallet,
             w.referred_wallet,
             u.created_at as signed_up_at,
             r.created_at as referred_at,
             r.source,
             coalesce(w.network, p_network) as network,
             (select count(*)::integer
                from public.referral_chain_activity c
               where c.user_id = r.referred_user_id
                 and c.network = coalesce(w.network, p_network)
                 and c.occurred_at >= r.created_at) as activity_count,
             w.qualified_at,
             w.status as reward_status,
             w.void_reason,
             w.amount_php,
             false as former_user,
             r.referred_user_id as tiebreak
        from public.referrals r
        join auth.users u on u.id = r.referred_user_id
        left join public.referral_rewards w
          on w.referred_user_id = r.referred_user_id and w.referrer_user_id = p_referrer
        left join public.wallet_accounts a on a.user_id = r.referred_user_id
        left join public.smart_wallets s
          on s.user_id = r.referred_user_id and s.network = coalesce(w.network, p_network)
       where r.referrer_user_id = p_referrer
      union all
      select w.id, null, null, null, w.referred_wallet, null, null, null, w.network, null, w.qualified_at,
             w.status, w.void_reason, w.amount_php, true, w.id
        from public.referral_rewards w
       where w.referrer_user_id = p_referrer
         and w.referred_user_id is null
    ) x
   order by coalesce(x.referred_at, x.qualified_at) desc, x.tiebreak;
$$;

-- Why a payout step was refused, in words an admin can act on: the live claim on
-- p_referrer, if any, and who holds it; and the payouts that already paid any of
-- p_reward_ids, by whom and when. Read after a DQR02 or DQR07.
create function public.referral_payout_conflict(p_referrer uuid, p_reward_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'claim', (
      select jsonb_build_object('admin_id', c.claimed_by, 'email', u.email::text, 'wallet', a.address,
                                'claimed_at', c.claimed_at, 'expires_at', c.expires_at)
        from public.referral_payout_claims c
        join auth.users u on u.id = c.claimed_by
        left join public.wallet_accounts a on a.user_id = c.claimed_by
       where c.referrer_user_id = p_referrer and c.expires_at > now()
       order by c.claimed_at desc
       limit 1),
    'paid', coalesce((
      select jsonb_agg(jsonb_build_object('admin_id', p.paid_by, 'email', u.email::text, 'wallet', a.address,
                                          'paid_at', p.paid_at, 'amount_php', p.amount_php,
                                          'reward_count', p.reward_count)
                       order by p.paid_at)
        from public.referral_payouts p
        left join auth.users u on u.id = p.paid_by
        left join public.wallet_accounts a on a.user_id = p.paid_by
       where p.id in (select w.payout_id from public.referral_rewards w
                       where w.id = any(p_reward_ids) and w.payout_id is not null)), '[]'::jsonb));
$$;

comment on function public.referral_payout_queue() is
  'The admin payout queue, with payout details in full and any live claim (DOQ-26). Service role only.';
comment on function public.referral_payout_referrals(uuid, text) is
  'A referrer''s referred accounts in full, for admin review (DOQ-26). Service role only.';
comment on function public.referral_payout_conflict(uuid, uuid[]) is
  'Who holds a live claim on a referrer, and who already paid any of the rewards (DOQ-26). Service role only.';

-- ---------------------------------------------------------------------------
-- Service role only
-- ---------------------------------------------------------------------------

revoke all on public.referral_payouts, public.referral_payout_claims from public, anon, authenticated, service_role;
grant select on public.referral_payouts, public.referral_payout_claims to service_role;

revoke execute on function
  public.referral_payout_profiles_before_update(),
  public.referral_payouts_keep(),
  public.referral_rewards_paid_final(),
  public.referral_payout_check_request(uuid, uuid[], integer, timestamptz, uuid),
  public.referral_payout_check_rewards(uuid, uuid[], integer, boolean),
  public.referral_payout_account_gone(text),
  public.start_referral_payout(uuid, uuid[], integer, timestamptz, uuid),
  public.release_referral_payout(uuid, uuid),
  public.mark_referral_rewards_paid(uuid, uuid[], integer, timestamptz, text, uuid),
  public.restore_referral_reward(uuid, integer),
  public.referral_payout_queue(),
  public.referral_payout_referrals(uuid, text),
  public.referral_payout_conflict(uuid, uuid[])
  from public, anon, authenticated;
-- The triggers' and the internal helpers': only the functions above call them, as their owner.
revoke execute on function
  public.referral_payout_profiles_before_update(),
  public.referral_payouts_keep(),
  public.referral_rewards_paid_final(),
  public.referral_payout_check_request(uuid, uuid[], integer, timestamptz, uuid),
  public.referral_payout_check_rewards(uuid, uuid[], integer, boolean),
  public.referral_payout_account_gone(text)
  from service_role;
grant execute on function
  public.start_referral_payout(uuid, uuid[], integer, timestamptz, uuid),
  public.release_referral_payout(uuid, uuid),
  public.mark_referral_rewards_paid(uuid, uuid[], integer, timestamptz, text, uuid),
  public.restore_referral_reward(uuid, integer),
  public.referral_payout_queue(),
  public.referral_payout_referrals(uuid, text),
  public.referral_payout_conflict(uuid, uuid[])
  to service_role;
