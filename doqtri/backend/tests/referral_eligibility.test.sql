-- pgTAP tests for 20261107100000_referral_eligibility.sql (WP-4.6, DOQ-23,
-- D-109, D-110): the 3rd activity makes a referral eligible and the 2nd
-- doesn't, a transaction counts once and only from when the referral was
-- recorded, only confirmed chain_writes count, the 31st qualifying referral is
-- over the limit and moves up when a place opens, a wallet earns once per
-- network, clients can read and run none of it, and deleting either user
-- leaves what the ticket says it leaves.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/referral_eligibility.test.sql
--
-- Everything runs in one transaction that is rolled back. Users and referrals
-- are written as the table owner; the functions run as the service role, as
-- the app calls them, wherever the role is set. Rules come from the test's
-- calls, as they come from lib/referral-program.ts in the app: 3, 30 PHP, 30.
--
-- One session can never be blocked by its own advisory lock, so this file
-- can't show two qualifications really overlapping (AC 6; that is
-- referral_eligibility_concurrency.test.sql). It checks what one session can:
-- repeating every call changes nothing, the unique indexes refuse a second
-- reward, and every function that decides a place takes the lock.
--
-- The backfill checks hold for whatever rows the database had when the
-- migration ran: run against a copy of production, or with rows inserted
-- before the migration, they check them all. On an empty database they pass
-- without checking anything, so the sweep the backfill calls is tested below
-- on rows of its own.

begin;
create extension if not exists pgtap with schema extensions;

select plan(117);

-- ---------------------------------------------------------------------------
-- The backfill, before anything here adds rows
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int
     from public.chain_writes c
     join public.smart_wallets s on s.network = c.network and s.address = c.owner
     join public.referrals r on r.referred_user_id = s.user_id
    where c.status = 'confirmed' and c.created_at >= r.created_at
      and not exists (select 1 from public.referral_chain_activity a
                       where a.network = c.network and a.tx_hash = c.tx_hash)),
  0, 'the backfill holds every referred user''s confirmed chain write from since their referral');
select is(
  (select count(*)::int
     from public.referral_chain_activity a
     join public.referrals r on r.referred_user_id = a.user_id
    where a.occurred_at < r.created_at),
  0, 'and none from before it');
select is((select count(*)::int from public.referral_rewards), 0,
  'it creates no rewards: it doesn''t know the threshold, so the first sync qualifies them');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function pg_temp.uid(p_n int) returns uuid language sql immutable as $$
  select ('60000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;

-- A wallet address of the given kind for a number; 0, 1, 8 and 9 aren't base32.
create function pg_temp.wallet(p_kind text, p_n int) returns text language sql immutable as $$
  select p_kind || lpad(translate(p_n::text, '0189', 'ABCD'), 55, 'A')
$$;

create function pg_temp.tx(p_n int) returns text language sql immutable as $$
  select lpad(to_hex(p_n), 64, '0')
$$;

create function pg_temp.add_user(p_n int) returns void language sql as $$
  insert into auth.users (id, email) values (pg_temp.uid(p_n), 'user' || p_n || '@example.com')
$$;

-- p_n signs up through p_referrer's code, an hour ago unless told otherwise.
create function pg_temp.refer(p_n int, p_referrer int, p_at timestamptz default now() - interval '1 hour')
returns void language plpgsql as $$
begin
  perform pg_temp.add_user(p_n);
  insert into public.referrals (referred_user_id, referrer_user_id, code, created_at)
  values (pg_temp.uid(p_n), pg_temp.uid(p_referrer), 'abcdefgh', p_at);
end;
$$;

create function pg_temp.act(p_n int, p_tx int, p_wallet text, p_at timestamptz default now(), p_network text default 'testnet')
returns void language sql as $$
  select public.record_referral_activity(
    pg_temp.uid(p_n), p_network, pg_temp.tx(p_tx), p_wallet, 'anchor', p_at, 3, 30, 30)
$$;

-- p_n's three calls, from their own wallet, numbered clear of everything else.
create function pg_temp.qualify(p_n int, p_wallet text default null, p_network text default 'testnet')
returns void language plpgsql as $$
begin
  for i in 1..3 loop
    perform pg_temp.act(p_n, 1000000 + p_n * 10 + i, coalesce(p_wallet, pg_temp.wallet('G', p_n)), now(), p_network);
  end loop;
end;
$$;

create function pg_temp.settle(p_n int) returns void language sql as $$
  select public.settle_referral_activity(pg_temp.uid(p_n), 'testnet', 3, 30, 30)
$$;

create function pg_temp.activity(p_n int) returns int language sql as $$
  select count(*)::int from public.referral_chain_activity where user_id = pg_temp.uid(p_n)
$$;

create function pg_temp.status(p_n int) returns text language sql as $$
  select status from public.referral_rewards where referred_user_id = pg_temp.uid(p_n)
$$;

create function pg_temp.reward_id(p_n int) returns uuid language sql as $$
  select id from public.referral_rewards where referred_user_id = pg_temp.uid(p_n)
$$;

create function pg_temp.count_by(p_referrer int, p_status text) returns int language sql as $$
  select count(*)::int from public.referral_rewards
   where referrer_user_id = pg_temp.uid(p_referrer) and status = p_status
$$;

create function pg_temp.write(p_doc uuid, p_tx int, p_wallet text, p_status text, p_at timestamptz default now())
returns void language sql as $$
  insert into public.chain_writes (network, tx_hash, document_id, fn, owner, status, created_at)
  values ('testnet', pg_temp.tx(p_tx), p_doc, 'anchor', p_wallet, p_status, p_at)
$$;

-- ---------------------------------------------------------------------------
-- The tables and functions
-- ---------------------------------------------------------------------------

select is(
  (select array_agg(c.relname::text order by c.relname) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relrowsecurity
      and c.relname in ('referral_chain_activity', 'referral_rewards', 'referral_reward_limits', 'referral_activity_sync')),
  array['referral_activity_sync', 'referral_chain_activity', 'referral_reward_limits', 'referral_rewards'],
  'row level security is on for all four tables');
select is(
  (select count(*)::int from pg_policies
    where tablename in ('referral_chain_activity', 'referral_rewards', 'referral_reward_limits', 'referral_activity_sync')),
  0, 'with no policies');
select is(
  (select array_agg(c.conrelid::regclass::text || '.' || a.attname || ':' || c.confdeltype::text
                    order by c.conrelid::regclass::text, a.attname::text)
     from pg_constraint c
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'auth.users'::regclass
      and c.conrelid::regclass::text in ('referral_chain_activity', 'referral_rewards', 'referral_reward_limits', 'referral_activity_sync')),
  array['referral_activity_sync.referred_user_id:c', 'referral_chain_activity.user_id:c', 'referral_reward_limits.user_id:c',
        'referral_rewards.referred_user_id:n', 'referral_rewards.referrer_user_id:n'],
  'a reward outlives both its users (set null); everything else goes with the user');

create temp table referral_fns as
  select p.oid, p.proname::text as name
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('referral_rewards_before_update', 'lock_referral_referrer', 'referral_places_left',
                       'promote_referral_rewards', 'sweep_referral_chain_writes', 'qualify_referral',
                       'record_referral_activity', 'settle_referral_activity', 'referral_sync_candidates',
                       'void_referral_reward', 'set_referral_reward_limit');
grant select on referral_fns to anon, authenticated, service_role;

select is((select count(*)::int from referral_fns), 11, 'the eleven functions exist');
select is((select array_agg(name) from referral_fns f join pg_proc p on p.oid = f.oid where p.prosecdef),
  null::text[], 'none is security definer: they run as the service role');
select is(
  (select array_agg(name) from referral_fns f join pg_proc p on p.oid = f.oid
    where not coalesce(p.proconfig @> array['search_path=""'], false)),
  null::text[], 'all have an empty search_path');

-- AC 6, as far as one session can check it.
select matches(pg_get_functiondef('public.lock_referral_referrer(uuid)'::regprocedure), 'pg_advisory_xact_lock',
  'the referrer lock is a transaction-scoped advisory lock');
select is(
  (select array_agg(name order by name) from referral_fns f
    where pg_get_functiondef(f.oid) ~ 'lock_referral_referrer\(' and name <> 'lock_referral_referrer'),
  array['promote_referral_rewards', 'qualify_referral', 'set_referral_reward_limit', 'void_referral_reward'],
  'and qualifying, promoting, voiding and changing a limit all take it');

-- ---------------------------------------------------------------------------
-- The threshold (AC 1), as the service role
-- ---------------------------------------------------------------------------

select pg_temp.add_user(1);
select pg_temp.refer(2, 1);
select pg_temp.add_user(3);

set local role service_role;

select lives_ok($$ select pg_temp.act(3, 1, pg_temp.wallet('G', 3)) $$, 'a user with no referral: nothing fails');
select is(pg_temp.activity(3), 0, 'and nothing is stored');

select pg_temp.act(2, 2, pg_temp.wallet('G', 2));
select pg_temp.act(2, 3, pg_temp.wallet('G', 2));
select is(pg_temp.activity(2), 2, 'two activities are stored');
select is((select count(*)::int from public.referral_rewards where referred_user_id = pg_temp.uid(2)), 0,
  'and 2 is not enough: no reward');

select pg_temp.act(2, 4, pg_temp.wallet('G', 2));
select results_eq(
  $$ select network, referrer_user_id, referred_wallet, amount_php, status, void_reason
       from public.referral_rewards where referred_user_id = pg_temp.uid(2) $$,
  $$ values ('testnet'::text, pg_temp.uid(1), pg_temp.wallet('G', 2), 30, 'eligible'::text, null::text) $$,
  'the 3rd makes the referral eligible, with the wallet, the referrer and the amount');
select ok((select qualified_at is not null from public.referral_rewards where referred_user_id = pg_temp.uid(2)),
  'stamped with when it qualified');

select pg_temp.act(2, 5, pg_temp.wallet('G', 2));
select is(
  (select count(*)::int from public.referral_rewards where referred_user_id = pg_temp.uid(2)), 1,
  'a 4th adds no second reward');

delete from public.referral_chain_activity where user_id = pg_temp.uid(2);
select pg_temp.settle(2);
select is(pg_temp.status(2), 'eligible', 'and with the activity gone, as after a ledger reset, it stays eligible');

reset role;

-- The rules come from the arguments, not from anything the SQL repeats.
select pg_temp.refer(4, 1);
select public.record_referral_activity(pg_temp.uid(4), 'testnet', pg_temp.tx(40), pg_temp.wallet('G', 4), 'anchor', now(), 1, 75, 30);
select results_eq(
  $$ select amount_php, status from public.referral_rewards where referred_user_id = pg_temp.uid(4) $$,
  $$ values (75, 'eligible'::text) $$,
  'the threshold and the amount are whatever the app passes');

-- ---------------------------------------------------------------------------
-- A transaction seen twice, and the window (AC 2, AC 4)
-- ---------------------------------------------------------------------------

select pg_temp.refer(5, 1);
select pg_temp.act(5, 50, pg_temp.wallet('G', 5));
select pg_temp.act(5, 50, pg_temp.wallet('G', 5));
select pg_temp.act(5, 50, pg_temp.wallet('G', 5));
select is(pg_temp.activity(5), 1, 'the same transaction three times counts once');
select is(pg_temp.status(5), null, 'and earns nothing');

select pg_temp.refer(6, 1, '2026-06-01 12:00:00+00');
select pg_temp.act(6, 60, pg_temp.wallet('G', 6), '2026-06-01 11:59:59+00');
select is(pg_temp.activity(6), 0, 'a transaction from before the referral was recorded doesn''t count');
select pg_temp.act(6, 61, pg_temp.wallet('G', 6), '2026-06-01 12:00:00+00');
select is(pg_temp.activity(6), 1, 'one at that very moment does');

-- A new referral starts the count again, though rows from an earlier one survive
-- its referrer's deletion: only the referral cascades.
select pg_temp.add_user(14);
select pg_temp.add_user(15);
select pg_temp.refer(16, 14, now() - interval '2 hours');
select pg_temp.act(16, 160, pg_temp.wallet('G', 16), now() - interval '100 minutes');
select pg_temp.act(16, 161, pg_temp.wallet('G', 16), now() - interval '90 minutes');
delete from auth.users where id = pg_temp.uid(14);
insert into public.referrals (referred_user_id, referrer_user_id, code, created_at)
values (pg_temp.uid(16), pg_temp.uid(15), 'abcdefgh', now() - interval '1 hour');
select is(pg_temp.activity(16), 2, 'a deleted referrer''s referee keeps their earlier activity');
select pg_temp.act(16, 162, pg_temp.wallet('G', 16));
select is(pg_temp.status(16), null, 'but with a new referral, 2 from before it and 1 since earn nothing (AC 4)');
select pg_temp.settle(16);
select is(pg_temp.status(16), null, 'nor does a sync');
select pg_temp.act(16, 163, pg_temp.wallet('G', 16));
select pg_temp.act(16, 164, pg_temp.wallet('G', 16));
select results_eq(
  $$ select referrer_user_id, status from public.referral_rewards where referred_user_id = pg_temp.uid(16) $$,
  $$ values (pg_temp.uid(15), 'eligible'::text) $$,
  'the 3rd since it does');

-- ---------------------------------------------------------------------------
-- Passkey writes through chain_writes (AC 2, AC 3)
-- ---------------------------------------------------------------------------

select pg_temp.add_user(7);
select pg_temp.refer(8, 7, now() - interval '1 day');
insert into public.smart_wallets (user_id, network, address, created_tx)
values (pg_temp.uid(8), 'testnet', pg_temp.wallet('C', 8), repeat('a', 64));
create temp table doc as
  select gen_random_uuid() as id,
         (select id from public.workspaces where is_personal and created_by = pg_temp.uid(8)) as workspace_id;
grant select on doc to service_role;
insert into public.documents (id, user_id, workspace_id, title, markdown)
select id, pg_temp.uid(8), workspace_id, 'Note', '# Note' from doc;

select pg_temp.write((select id from doc), 80, pg_temp.wallet('C', 8), 'confirmed', now() - interval '2 days');
select pg_temp.write((select id from doc), 81, pg_temp.wallet('C', 8), 'failed');
select pg_temp.write((select id from doc), 82, pg_temp.wallet('C', 8), 'pending');
select pg_temp.write((select id from doc), 83, pg_temp.wallet('C', 8), 'confirmed');

set local role service_role;
select is((select count(*)::int from public.referral_sync_candidates('testnet', 1000, 0) where user_id = pg_temp.uid(8)), 1,
  'a referred passkey user waits to be synced');
select pg_temp.settle(8);
select results_eq(
  $$ select tx_hash, wallet, fn from public.referral_chain_activity where user_id = pg_temp.uid(8) $$,
  $$ values (pg_temp.tx(83), pg_temp.wallet('C', 8), 'anchor'::text) $$,
  'the sweep counts the confirmed write since the referral: not the older one, the failed one or the pending one');
select ok((select synced_at is not null from public.referral_activity_sync where referred_user_id = pg_temp.uid(8)),
  'and stamps the sync');

update public.chain_writes set status = 'confirmed' where tx_hash = pg_temp.tx(82);
select pg_temp.settle(8);
select is(pg_temp.activity(8), 2, 'a pending write counts once it has confirmed');
select pg_temp.settle(8);
select is(pg_temp.activity(8), 2, 'and a sweep repeated counts nothing twice');
select is(pg_temp.status(8), null, 'two: nothing yet');

-- The relay recorded it, and chain_writes holds it too: still one.
select pg_temp.act(8, 84, pg_temp.wallet('C', 8));
reset role;
select pg_temp.write((select id from doc), 84, pg_temp.wallet('C', 8), 'confirmed');
set local role service_role;
select pg_temp.settle(8);
select is(pg_temp.activity(8), 3, 'a write both the relay and the sweep saw counts once');
select is(pg_temp.status(8), 'eligible', 'and it was the 3rd');
select is((select count(*)::int from public.referral_sync_candidates('testnet', 1000, 0) where user_id = pg_temp.uid(8)), 0,
  'a user with a reward is no longer synced');
reset role;

-- The sweep alone, as the migration's backfill calls it, then the first sync.
select pg_temp.refer(9, 7);
insert into public.smart_wallets (user_id, network, address, created_tx)
values (pg_temp.uid(9), 'testnet', pg_temp.wallet('C', 9), repeat('b', 64));
create temp table doc9 as
  select gen_random_uuid() as id,
         (select id from public.workspaces where is_personal and created_by = pg_temp.uid(9)) as workspace_id;
insert into public.documents (id, user_id, workspace_id, title, markdown)
select id, pg_temp.uid(9), workspace_id, 'Note', '# Note' from doc9;
select pg_temp.write((select id from doc9), 90, pg_temp.wallet('C', 9), 'confirmed');
select pg_temp.write((select id from doc9), 91, pg_temp.wallet('C', 9), 'confirmed');
select pg_temp.write((select id from doc9), 92, pg_temp.wallet('C', 9), 'confirmed');
select public.sweep_referral_chain_writes(pg_temp.uid(9), 'testnet');
select is(pg_temp.activity(9), 3, 'the backfill''s sweep turns confirmed writes into activity');
select is(pg_temp.status(9), null, 'without creating a reward');
select pg_temp.settle(9);
select is(pg_temp.status(9), 'eligible', 'the first sync run qualifies them');

-- ---------------------------------------------------------------------------
-- Who the sync reads (AC 3)
-- ---------------------------------------------------------------------------

select pg_temp.add_user(10);
select pg_temp.refer(11, 10, '2026-06-01 12:00:00+00');
insert into public.wallet_accounts (address, user_id) values (pg_temp.wallet('G', 11), pg_temp.uid(11));
select pg_temp.refer(12, 10, '2026-06-02 12:00:00+00');
insert into public.smart_wallets (user_id, network, address, created_tx)
values (pg_temp.uid(12), 'testnet', pg_temp.wallet('C', 12), repeat('c', 64));
select pg_temp.refer(13, 10, '2026-06-03 12:00:00+00');

set local role service_role;
select results_eq(
  $$ select user_id, referred_at, c_wallet, g_wallet from public.referral_sync_candidates('testnet', 1000, 0)
      where user_id in (pg_temp.uid(11), pg_temp.uid(12), pg_temp.uid(13)) $$,
  $$ values (pg_temp.uid(11), '2026-06-01 12:00:00+00'::timestamptz, null::text, pg_temp.wallet('G', 11)),
            (pg_temp.uid(12), '2026-06-02 12:00:00+00'::timestamptz, pg_temp.wallet('C', 12), null::text),
            (pg_temp.uid(13), '2026-06-03 12:00:00+00'::timestamptz, null::text, null::text) $$,
  'candidates come with their wallets, the never-synced oldest referral first');
select pg_temp.settle(11);
select results_eq(
  $$ select user_id from public.referral_sync_candidates('testnet', 1000, 0)
      where user_id in (pg_temp.uid(11), pg_temp.uid(12), pg_temp.uid(13)) $$,
  $$ values (pg_temp.uid(12)), (pg_temp.uid(13)), (pg_temp.uid(11)) $$,
  'and a user just synced goes to the back');
select is((select count(*)::int from public.referral_sync_candidates('testnet', 2, 0)), 2, 'a run takes only its limit');

-- Who has just had a turn waits (user 11, settled above).
select is((select count(*)::int from public.referral_sync_candidates('testnet', 1000, 900) where user_id = pg_temp.uid(11)), 0,
  'a user synced in the last 15 minutes waits');
select is((select count(*)::int from public.referral_sync_candidates('testnet', 1000, 900) where user_id = pg_temp.uid(12)), 1,
  'one never synced doesn''t');
update public.referral_activity_sync set synced_at = now() - interval '14 minutes' where referred_user_id = pg_temp.uid(11);
select is((select count(*)::int from public.referral_sync_candidates('testnet', 1000, 900) where user_id = pg_temp.uid(11)), 0,
  'nor is 14 minutes enough');
update public.referral_activity_sync set synced_at = now() - interval '15 minutes' where referred_user_id = pg_temp.uid(11);
select is((select count(*)::int from public.referral_sync_candidates('testnet', 1000, 900) where user_id = pg_temp.uid(11)), 1,
  'at 15 minutes it has its turn again');
select is((select c_wallet from public.referral_sync_candidates('mainnet', 1000, 0) where user_id = pg_temp.uid(12)), null,
  'a smart wallet counts only on its own network');
reset role;

-- ---------------------------------------------------------------------------
-- The limit (AC 5, AC 6)
-- ---------------------------------------------------------------------------

select pg_temp.add_user(100);
select pg_temp.refer(n, 100) from generate_series(101, 136) as n;

set local role service_role;
select pg_temp.qualify(n) from generate_series(101, 130) as n;
select is(pg_temp.count_by(100, 'eligible'), 30, 'the first 30 to qualify are eligible');
select is(pg_temp.count_by(100, 'over_limit'), 0, 'with none over the limit');

select pg_temp.qualify(131);
select is(pg_temp.status(131), 'over_limit', 'the 31st is over the limit');
select is((select amount_php from public.referral_rewards where referred_user_id = pg_temp.uid(131)), 30,
  'still with its amount, for when it moves up');
select pg_temp.qualify(132);
select pg_temp.qualify(133);
select is(pg_temp.count_by(100, 'over_limit'), 3, 'and so are the next ones');

-- Oldest first, by when they qualified, whatever their ids say.
update public.referral_rewards set qualified_at = '2026-06-03' where referred_user_id = pg_temp.uid(131);
update public.referral_rewards set qualified_at = '2026-06-02' where referred_user_id = pg_temp.uid(132);
update public.referral_rewards set qualified_at = '2026-06-01' where referred_user_id = pg_temp.uid(133);

select is(public.void_referral_reward(pg_temp.reward_id(101), 'fraud', 30), true, 'voiding an eligible reward works');
select results_eq(
  $$ select status, void_reason from public.referral_rewards where referred_user_id = pg_temp.uid(101) $$,
  $$ values ('void'::text, 'fraud'::text) $$,
  'and keeps the reason');
select is(pg_temp.status(133), 'eligible', 'the oldest over-limit reward moves up');
select is(pg_temp.count_by(100, 'eligible'), 30, 'back to 30');
select is(pg_temp.count_by(100, 'over_limit'), 2, 'with two still waiting');

-- Paid rewards hold their place and can't be voided. Paid the only way a reward
-- can be (DOQ-26).
insert into public.referral_payout_profiles (user_id, method, name, xlm_address)
values (pg_temp.uid(100), 'xlm', 'Payout Holder', 'G' || repeat('P', 55));
select public.start_referral_payout(pg_temp.uid(100), array[pg_temp.reward_id(102)], 30, (select updated_at from public.referral_payout_profiles where user_id = pg_temp.uid(100)), pg_temp.uid(100));
select public.mark_referral_rewards_paid(
  pg_temp.uid(100), array[pg_temp.reward_id(102)], 30,
  (select updated_at from public.referral_payout_profiles where user_id = pg_temp.uid(100)), null, pg_temp.uid(100));
select is(public.void_referral_reward(pg_temp.reward_id(102), 'fraud', 30), false, 'a paid reward can''t be voided');
select is(pg_temp.status(102), 'paid', 'and stays paid');
select is(pg_temp.count_by(100, 'over_limit'), 2, 'nothing moved up for it');

select throws_ok($$ select public.void_referral_reward(pg_temp.reward_id(103), null, 30) $$,
  '22023', null, 'a void needs a reason');
select throws_ok($$ select public.void_referral_reward(pg_temp.reward_id(103), '  ', 30) $$,
  '22023', null, 'not a blank one');
select throws_ok($$ select public.void_referral_reward(pg_temp.reward_id(103), 'duplicate_wallet', 30) $$,
  '22023', null, 'and not the one reason that would let the wallet earn again');
select is(public.void_referral_reward(pg_temp.reward_id(101), 'again', 30), false, 'a void reward can''t be voided again');
select is((select void_reason from public.referral_rewards where referred_user_id = pg_temp.uid(101)), 'fraud',
  'its reason stands');
select is(public.void_referral_reward(gen_random_uuid(), 'fraud', 30), false, 'nor can a reward that doesn''t exist');

-- Raising the limit, lowering it.
select lives_ok($$ select public.set_referral_reward_limit(pg_temp.uid(100), 31, 30) $$, 'a limit can be raised');
select is(pg_temp.status(132), 'eligible', 'the next oldest moves up');
select is(pg_temp.status(131), 'over_limit', 'and only as many as there are new places');

select public.set_referral_reward_limit(pg_temp.uid(100), 5, 30);
select is(pg_temp.count_by(100, 'eligible') + pg_temp.count_by(100, 'paid'), 31, 'lowering a limit demotes nobody');
select pg_temp.qualify(134);
select is(pg_temp.status(134), 'over_limit', 'but the next to qualify is measured against it');
select is(public.void_referral_reward(pg_temp.reward_id(103), 'fraud', 30), true, 'voiding under a lowered limit works');
select is(pg_temp.status(131), 'over_limit', 'and opens no place while still over it');
select is(public.void_referral_reward(pg_temp.reward_id(134), 'fraud', 30), true, 'an over-limit reward can be voided too');
select is(pg_temp.count_by(100, 'over_limit'), 1, 'and stops waiting');

select throws_ok($$ select public.set_referral_reward_limit(pg_temp.uid(100), -1, 30) $$,
  '23514', null, 'a limit can''t be negative');

select public.set_referral_reward_limit(pg_temp.uid(100), 100, 30);
select is(pg_temp.status(131), 'eligible', 'raising it again moves the last one up');
select pg_temp.qualify(135);
select is(pg_temp.status(135), 'eligible', 'and a raised limit lets the next one straight in');

-- AC 6: everything repeated, and what would stop a second reward regardless.
select pg_temp.qualify(n) from generate_series(101, 135) as n;
select pg_temp.settle(n) from generate_series(101, 135) as n;
select is((select count(*)::int from public.referral_rewards where referrer_user_id = pg_temp.uid(100)), 35,
  'every call repeated: still one reward per referral');
select results_eq(
  $$ select status, count(*)::int from public.referral_rewards
      where referrer_user_id = pg_temp.uid(100) group by status order by status $$,
  $$ values ('eligible'::text, 31), ('paid'::text, 1), ('void'::text, 3) $$,
  'and no status moved');
select throws_ok(
  $$ insert into public.referral_rewards (network, referrer_user_id, referred_user_id, referred_wallet, amount_php, status)
     values ('testnet', pg_temp.uid(100), pg_temp.uid(135), pg_temp.wallet('G', 999), 30, 'eligible') $$,
  '23505', null, 'the database refuses a second reward for one referral');
select throws_ok(
  $$ insert into public.referral_rewards (network, referrer_user_id, referred_user_id, referred_wallet, amount_php, status)
     values ('testnet', pg_temp.uid(100), pg_temp.uid(136), pg_temp.wallet('G', 135), 30, 'eligible') $$,
  '23505', null, 'and a second reward for one wallet on a network');
select throws_ok(
  $$ update public.referral_rewards set status = 'void' where referred_user_id = pg_temp.uid(135) $$,
  '23514', null, 'and a void reward with no reason');
reset role;

-- ---------------------------------------------------------------------------
-- One reward per wallet per network (AC 7)
-- ---------------------------------------------------------------------------

select pg_temp.add_user(200);
select pg_temp.refer(201, 200);
insert into public.wallet_accounts (address, user_id) values (pg_temp.wallet('G', 777), pg_temp.uid(201));
select pg_temp.qualify(201, pg_temp.wallet('G', 777));
select is(pg_temp.status(201), 'eligible', 'a wallet login earns a reward');

delete from auth.users where id = pg_temp.uid(201);
select pg_temp.refer(202, 200);
insert into public.wallet_accounts (address, user_id) values (pg_temp.wallet('G', 777), pg_temp.uid(202));
select pg_temp.qualify(202, pg_temp.wallet('G', 777));
select results_eq(
  $$ select status, void_reason, referred_wallet from public.referral_rewards where referred_user_id = pg_temp.uid(202) $$,
  $$ values ('void'::text, 'duplicate_wallet'::text, pg_temp.wallet('G', 777)) $$,
  'deleting the account and signing up again with that wallet earns no second reward');
select results_eq(
  $$ select status, referred_user_id from public.referral_rewards
      where referred_wallet = pg_temp.wallet('G', 777) and void_reason is null $$,
  $$ values ('eligible'::text, null::uuid) $$,
  'the first reward stays as it was');
select is(pg_temp.count_by(200, 'eligible'), 1, 'and the duplicate takes no place');

select pg_temp.refer(203, 200);
select pg_temp.qualify(203, pg_temp.wallet('G', 777));
select is(pg_temp.status(203), 'void', 'a third account on the wallet is voided too, beside the second');

select pg_temp.refer(204, 200);
select pg_temp.qualify(204, pg_temp.wallet('G', 777), 'mainnet');
select results_eq(
  $$ select network, status from public.referral_rewards where referred_user_id = pg_temp.uid(204) $$,
  $$ values ('mainnet'::text, 'eligible'::text) $$,
  'on another network the wallet can earn');

-- A voided reward still holds its wallet.
select pg_temp.refer(205, 200);
select pg_temp.qualify(205, pg_temp.wallet('G', 778));
select public.void_referral_reward(pg_temp.reward_id(205), 'fraud', 30);
delete from auth.users where id = pg_temp.uid(205);
select pg_temp.refer(206, 200);
select pg_temp.qualify(206, pg_temp.wallet('G', 778));
select results_eq(
  $$ select status, void_reason from public.referral_rewards where referred_user_id = pg_temp.uid(206) $$,
  $$ values ('void'::text, 'duplicate_wallet'::text) $$,
  'a wallet whose reward was voided can''t earn again by signing up again');

-- A passkey wallet comes back the same way.
select pg_temp.refer(207, 200);
insert into public.smart_wallets (user_id, network, address, created_tx)
values (pg_temp.uid(207), 'testnet', pg_temp.wallet('C', 777), repeat('d', 64));
select pg_temp.qualify(207, pg_temp.wallet('C', 777));
select is(pg_temp.status(207), 'eligible', 'a passkey wallet earns');
delete from auth.users where id = pg_temp.uid(207);
select pg_temp.refer(208, 200);
insert into public.smart_wallets (user_id, network, address, created_tx)
values (pg_temp.uid(208), 'testnet', pg_temp.wallet('C', 777), repeat('e', 64));
select pg_temp.qualify(208, pg_temp.wallet('C', 777));
select is(pg_temp.status(208), 'void', 'and earns once too');

-- ---------------------------------------------------------------------------
-- Clients can't reach any of it (AC 8)
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int
     from unnest(array['anon', 'authenticated']) as r(name),
          unnest(array['public.referral_chain_activity', 'public.referral_rewards',
                       'public.referral_reward_limits', 'public.referral_activity_sync']) as t(name),
          unnest(array['select', 'insert', 'update', 'delete']) as p(name)
    where has_table_privilege(r.name, t.name, p.name)),
  0, 'anon and authenticated hold no privilege on the four tables');
select is(
  (select array_agg(f.name) from referral_fns f, unnest(array['anon', 'authenticated']) as r(name)
    where has_function_privilege(r.name, f.oid, 'execute')),
  null::text[], 'nor execute on any function');
select is(
  (select array_agg(f.name) from referral_fns f
    where f.name <> 'referral_rewards_before_update' and not has_function_privilege('service_role', f.oid, 'execute')),
  null::text[], 'the service role can run all but the trigger''s');

set local role anon;
select throws_ok($$ select * from public.referral_rewards $$, '42501', null, 'anon can''t read rewards');
select throws_ok($$ select * from public.referral_chain_activity $$, '42501', null, 'or activity');
select throws_ok($$ select * from public.referral_reward_limits $$, '42501', null, 'or limits');
select throws_ok($$ select * from public.referral_activity_sync $$, '42501', null, 'or the sync''s record');
select throws_ok($$ update public.referral_rewards set status = 'paid' $$, '42501', null, 'or mark a reward paid');
select throws_ok($$ select pg_temp.act(5, 500, pg_temp.wallet('G', 5)) $$, '42501', null, 'or record activity');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "60000000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
select throws_ok($$ select * from public.referral_rewards $$, '42501', null, 'a signed-in referrer can''t read their rewards directly');
select throws_ok($$ select * from public.referral_chain_activity $$, '42501', null, 'or activity');
select throws_ok($$ select * from public.referral_reward_limits $$, '42501', null, 'or limits');
select throws_ok($$ select * from public.referral_activity_sync $$, '42501', null, 'or the sync''s record');
select throws_ok(
  $$ insert into public.referral_reward_limits (user_id, reward_limit) values ('60000000-0000-4000-8000-000000000001', 1000) $$,
  '42501', null, 'or raise their own limit');
select throws_ok($$ select public.set_referral_reward_limit(pg_temp.uid(1), 1000, 30) $$, '42501', null, 'not through the function either');
select throws_ok($$ select pg_temp.act(5, 500, pg_temp.wallet('G', 5)) $$, '42501', null, 'or record activity');
reset role;

-- ---------------------------------------------------------------------------
-- Deleting either user (AC 11; the same again in account_deletion.test.sql and
-- account_anonymisation.test.sql)
-- ---------------------------------------------------------------------------

select pg_temp.add_user(300);
select pg_temp.refer(301, 300);
select pg_temp.refer(302, 300);
select pg_temp.refer(303, 300);
select pg_temp.refer(304, 300);
select pg_temp.qualify(301);
select pg_temp.qualify(302);
insert into public.referral_payout_profiles (user_id, method, name, xlm_address)
values (pg_temp.uid(300), 'xlm', 'Payout Holder', 'G' || repeat('P', 55));
select public.start_referral_payout(pg_temp.uid(300), array[pg_temp.reward_id(302)], 30, (select updated_at from public.referral_payout_profiles where user_id = pg_temp.uid(300)), pg_temp.uid(300));
select public.mark_referral_rewards_paid(
  pg_temp.uid(300), array[pg_temp.reward_id(302)], 30,
  (select updated_at from public.referral_payout_profiles where user_id = pg_temp.uid(300)), null, pg_temp.uid(300));
select public.set_referral_reward_limit(pg_temp.uid(300), 2, 30);
select pg_temp.qualify(303);
select is(pg_temp.status(303), 'over_limit', 'a referrer with one eligible, one paid and one over the limit');
select pg_temp.act(304, 3040, pg_temp.wallet('G', 304));

delete from auth.users where id = pg_temp.uid(300);
select results_eq(
  $$ select referred_user_id, status, void_reason, referrer_user_id from public.referral_rewards
      where referred_user_id in (pg_temp.uid(301), pg_temp.uid(302), pg_temp.uid(303)) order by referred_user_id $$,
  $$ values (pg_temp.uid(301), 'void'::text, 'referrer_deleted'::text, null::uuid),
            (pg_temp.uid(302), 'paid'::text, null::text, null::uuid),
            (pg_temp.uid(303), 'void'::text, 'referrer_deleted'::text, null::uuid) $$,
  'deleting the referrer voids unpaid rewards and keeps the paid one');
select is((select count(*)::int from public.referral_reward_limits where user_id = pg_temp.uid(300)), 0,
  'its limit goes with it');
select pg_temp.qualify(304);
select is(pg_temp.status(304), null, 'and a referral that hadn''t qualified goes too: no reward can come of it');

select pg_temp.add_user(310);
select pg_temp.refer(311, 310);
select pg_temp.qualify(311);
select pg_temp.settle(311);
create temp table reward311 as select pg_temp.reward_id(311) as id;
delete from auth.users where id = pg_temp.uid(311);
select results_eq(
  $$ select referred_user_id, referrer_user_id, referred_wallet, status, amount_php
       from public.referral_rewards where id = (select id from reward311) $$,
  $$ values (null::uuid, pg_temp.uid(310), pg_temp.wallet('G', 311), 'eligible'::text, 30) $$,
  'deleting the referred user leaves the reward alone, for the Former user row');
select is(pg_temp.activity(311), 0, 'their activity goes with them');
select is((select count(*)::int from public.referral_activity_sync where referred_user_id = pg_temp.uid(311)), 0,
  'and their sync record');

select pg_temp.refer(312, 310);
select pg_temp.act(312, 3120, pg_temp.wallet('G', 312));
delete from auth.users where id = pg_temp.uid(312);
select is(
  (select count(*)::int from public.referrals where referred_user_id = pg_temp.uid(312))
  + pg_temp.activity(312)
  + (select count(*)::int from public.referral_rewards where referred_wallet = pg_temp.wallet('G', 312)),
  0, 'a referred user deleted before qualifying leaves nothing');

select * from finish();
rollback;
