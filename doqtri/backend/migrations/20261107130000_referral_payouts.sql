-- Paying referral rewards by hand, from the admin payouts panel (WP-4.6, DOQ-26,
-- D-110, D-112).
--
-- Admins read the queue at /admin/referrals/payouts, send each payout themselves
-- (nothing here or in the app transfers anything), then record it here. What
-- this adds:
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
--                           RLS on with no policies; the service role may read
--                           it, and delete rows (only the e2e suite's cleanup
--                           does), but never insert or change one: only
--                           mark_referral_rewards_paid() writes here.
--
--   referral_rewards        gains payout_id, set exactly when a reward is paid.
--     .payout_id
--
--   referral_payout_         gains created_at, when the details were first saved,
--     profiles.created_at    backfilled from updated_at. A trigger keeps it on
--                           every update, so an edit can't move a payout's due
--                           date, which counts from it (DOQ-29's 30 days).
--
--   paid is final           a trigger on referral_rewards: a paid reward's status,
--                           amount, payout, network, wallet and qualifying time
--                           never change, and its users can only become null (the
--                           two account deletions' set null). A reward becomes
--                           paid only from eligible, only inside
--                           mark_referral_rewards_paid(), which sets a
--                           transaction-local flag around its one update, and
--                           never on insert. So over_limit or void never becomes
--                           paid, and no service-role update can unpay a reward.
--
--   mark_referral_rewards_paid()
--                           under the referrer's lock (lock_referral_referrer),
--                           pays exactly the rewards the admin saw: every id
--                           eligible, the referrer's, and summing to the total the
--                           admin saw; the details as the admin saw them (their
--                           updated_at); and only with details saved. Anything
--                           else is refused and nothing is written, so two admins
--                           pressing at once give one payout: the second finds
--                           the rewards paid.
--
--   restore_referral_reward()
--                           a void reward back to eligible if the referrer has a
--                           place, else over_limit, under the lock. Never one void
--                           as duplicate_wallet (its wallet has already earned) or
--                           referrer_deleted (no one to pay).
--
--   referral_payout_queue(), referral_payout_referrals()
--                           what the panel reads: per referrer with something to
--                           act on, and per referred account for review. Security
--                           definer to read auth.users' emails, which the service
--                           role can't select, as referral_dashboard() does, so
--                           the whole queue is one query and not one Auth call per
--                           row. Activity counts follow qualify_referral(): the
--                           reward's network, or the app's when there's none yet,
--                           from when the referral was recorded.
--
-- Voiding and limits reuse void_referral_reward() and set_referral_reward_limit()
-- from 20261107100000_referral_eligibility.sql, which also promote the oldest
-- over-limit rewards when a place opens. The rules (default limit, threshold,
-- reward) stay in doqtri/frontend/lib/referral-program.ts and arrive as arguments.
--
-- Account deletion and the lock: a referrer's deletion locks their auth.users row
-- and then sets referrer_user_id null on their rewards, without the advisory lock
-- (see 20261107100000's header). mark_referral_rewards_paid() takes the advisory
-- lock and then a key share on that same auth.users row before touching any
-- reward, so whichever gets the account row first goes first and the two can't
-- deadlock; a payout that waited behind a deletion finds no account and is
-- refused.
--
-- Errors carry SQLSTATEs of their own, which the routes turn into fixed text:
--   DQR01  paid is final, or paying outside mark_referral_rewards_paid()
--   DQR02  the rewards changed since the admin looked
--   DQR03  the referrer has no payout details
--   DQR04  the payout details changed since the admin looked
--   DQR05  this void reward can't be restored
--   22023  an argument is missing or malformed

-- ---------------------------------------------------------------------------
-- When the payout details were first saved
-- ---------------------------------------------------------------------------

alter table public.referral_payout_profiles add column created_at timestamptz;
update public.referral_payout_profiles set created_at = updated_at;
alter table public.referral_payout_profiles
  alter column created_at set default now(),
  alter column created_at set not null;

comment on column public.referral_payout_profiles.created_at is
  'When the details were first saved. Never changes on an edit: a payout is due 30 days from it or the reward, whichever is later (DOQ-26).';

create function public.referral_payout_profiles_keep_created_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := old.created_at;
  return new;
end;
$$;

create trigger referral_payout_profiles_keep_created_at
  before update on public.referral_payout_profiles
  for each row execute function public.referral_payout_profiles_keep_created_at();

-- ---------------------------------------------------------------------------
-- The ledger
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
  'One row per payout an admin recorded by hand (DOQ-26). No address or account number. Outlives both users. Written only by mark_referral_rewards_paid().';
comment on column public.referral_payouts.paid_by is
  'The admin who recorded the payout; null once that account is deleted.';
comment on column public.referral_payouts.reference is
  'Optional: the transaction hash for XLM, or the e-wallet reference number.';

alter table public.referral_payouts enable row level security;

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
  before insert or update on public.referral_rewards
  for each row execute function public.referral_rewards_paid_final();

-- ---------------------------------------------------------------------------
-- Mark as paid
-- ---------------------------------------------------------------------------

-- Records one payout of exactly p_reward_ids, which the admin saw as eligible and
-- worth p_amount_php in all, to the details the admin saw (p_details_updated_at,
-- the profile's updated_at). Returns the payout's id. p_paid_by comes from the
-- admin's verified session.
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
  v_count      integer;
  v_total      bigint;
  v_payout     uuid;
begin
  if p_referrer is null or p_paid_by is null then
    raise exception 'A payout needs its referrer and the admin recording it.' using errcode = '22023';
  end if;
  if p_reward_ids is null or cardinality(p_reward_ids) = 0 or array_position(p_reward_ids, null) is not null
     or (select count(distinct x) from unnest(p_reward_ids) x) <> cardinality(p_reward_ids) then
    raise exception 'A payout needs the rewards it pays, each once.' using errcode = '22023';
  end if;
  if p_amount_php is null or p_amount_php <= 0 then
    raise exception 'A payout needs the amount the admin saw.' using errcode = '22023';
  end if;
  if v_reference is not null
     and (char_length(v_reference) > 100 or not public.referral_payout_text_ok(v_reference)) then
    raise exception 'A reference is at most 100 characters, with no line breaks or special characters.'
      using errcode = '22023';
  end if;

  perform public.lock_referral_referrer(p_referrer);

  -- Before any reward: see the header. Gone means a deletion went first, and
  -- voided whatever was unpaid.
  perform 1 from auth.users u where u.id = p_referrer for key share;
  if not found then
    raise exception 'These rewards changed since they were shown.' using errcode = 'DQR02';
  end if;

  -- Held until the end, so the details can't change while the payout is recorded.
  select p.method, p.ewallet_provider, p.updated_at
    into v_method, v_provider, v_details_at
    from public.referral_payout_profiles p
   where p.user_id = p_referrer
     for share;
  if not found then
    raise exception 'This referrer has no payout details yet.' using errcode = 'DQR03';
  end if;
  if v_details_at is distinct from p_details_updated_at then
    raise exception 'The payout details changed since they were shown.' using errcode = 'DQR04';
  end if;

  select count(*)::integer, coalesce(sum(w.amount_php), 0)
    into v_count, v_total
    from (select r.amount_php
            from public.referral_rewards r
           where r.id = any(p_reward_ids) and r.referrer_user_id = p_referrer and r.status = 'eligible'
           order by r.id
             for update) w;
  if v_count <> cardinality(p_reward_ids) or v_total <> p_amount_php then
    raise exception 'These rewards changed since they were shown.' using errcode = 'DQR02';
  end if;

  insert into public.referral_payouts
    (referrer_user_id, paid_by, amount_php, reward_count, method, ewallet_provider, reference)
  values (p_referrer, p_paid_by, p_amount_php, v_count, v_method,
          case when v_method = 'ewallet' then v_provider end, v_reference)
  returning id into v_payout;

  perform set_config('doqtri.paying_referral_rewards', 'on', true);
  update public.referral_rewards r
     set status = 'paid', payout_id = v_payout
   where r.id = any(p_reward_ids);
  perform set_config('doqtri.paying_referral_rewards', '', true);

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
-- oldest first), the other counts, their limit where an admin set one, and their
-- payout details in full. The app works out the amount owed and the due date.
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
  details_updated_at     timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.referrer_user_id,
         u.email::text,
         a.address,
         coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'amount_php', w.amount_php, 'qualified_at', w.qualified_at)
                            order by w.qualified_at, w.id)
                    filter (where w.status = 'eligible'), '[]'::jsonb),
         (count(*) filter (where w.status = 'over_limit'))::integer,
         (count(*) filter (where w.status = 'paid'))::integer,
         (count(*) filter (where w.status = 'void' and w.void_reason <> 'duplicate_wallet'))::integer,
         l.reward_limit,
         p.method, p.name, p.xlm_address, p.xlm_memo, p.xlm_memo_type,
         p.ewallet_provider, p.ewallet_account_name, p.ewallet_account_number, p.ewallet_details,
         p.created_at, p.updated_at
    from public.referral_rewards w
    join auth.users u on u.id = w.referrer_user_id
    left join public.wallet_accounts a on a.user_id = w.referrer_user_id
    left join public.referral_reward_limits l on l.user_id = w.referrer_user_id
    left join public.referral_payout_profiles p on p.user_id = w.referrer_user_id
   group by w.referrer_user_id, u.id, a.address, l.user_id, p.user_id
  having count(*) filter (where w.status in ('eligible', 'over_limit')
                              or (w.status = 'void' and w.void_reason <> 'duplicate_wallet')) > 0
   order by w.referrer_user_id;
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

comment on function public.referral_payout_queue() is
  'The admin payout queue, with payout details in full (DOQ-26). Service role only.';
comment on function public.referral_payout_referrals(uuid, text) is
  'A referrer''s referred accounts in full, for admin review (DOQ-26). Service role only.';

-- ---------------------------------------------------------------------------
-- Service role only
-- ---------------------------------------------------------------------------

revoke all on public.referral_payouts from public, anon, authenticated, service_role;
grant select, delete on public.referral_payouts to service_role;

revoke execute on function
  public.referral_payout_profiles_keep_created_at(),
  public.referral_rewards_paid_final(),
  public.mark_referral_rewards_paid(uuid, uuid[], integer, timestamptz, text, uuid),
  public.restore_referral_reward(uuid, integer),
  public.referral_payout_queue(),
  public.referral_payout_referrals(uuid, text)
  from public, anon, authenticated;
revoke execute on function
  public.referral_payout_profiles_keep_created_at(),
  public.referral_rewards_paid_final()
  from service_role;
grant execute on function
  public.mark_referral_rewards_paid(uuid, uuid[], integer, timestamptz, text, uuid),
  public.restore_referral_reward(uuid, integer),
  public.referral_payout_queue(),
  public.referral_payout_referrals(uuid, text)
  to service_role;
