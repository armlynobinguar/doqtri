-- pgTAP tests for 20261107130000_referral_payouts.sql (WP-4.6, DOQ-26, D-110,
-- D-112): the queue's amount owed, the two payout steps (a claim, its expiry, a
-- competing admin, releasing, recording without or with a mismatched claim) and
-- every refusal, paid being final (each refused transition, and no deleting),
-- the details' version, restoring, raising and lowering a limit, who can run or
-- read any of it, and what deleting a referrer or an admin leaves.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/referral_payouts.test.sql
--
-- Everything runs in one transaction that is rolled back. Users, referrals and
-- unpaid rewards are written as the table owner; the functions run as the service
-- role, as the app calls them. Rules come from the test's own arguments: a limit
-- of 30 unless a referrer's is set.
--
-- One session can never be blocked by its own advisory lock, so payout steps
-- really overlapping are in referral_payouts_concurrency.test.sql. Here, a second
-- call with the same rewards, after the first, is refused.

begin;
create extension if not exists pgtap with schema extensions;

select plan(159);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function pg_temp.uid(p_n int) returns uuid language sql immutable as $$
  select ('62000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
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

create function pg_temp.refer(p_n int, p_referrer int, p_at timestamptz default now() - interval '10 days')
returns void language plpgsql as $$
begin
  perform pg_temp.add_user(p_n);
  insert into public.referrals (referred_user_id, referrer_user_id, code, source, created_at)
  values (pg_temp.uid(p_n), pg_temp.uid(p_referrer), 'abcdefgh', 'link', p_at);
end;
$$;

create function pg_temp.act(p_n int, p_tx int, p_at timestamptz, p_network text default 'testnet')
returns void language sql as $$
  insert into public.referral_chain_activity (network, tx_hash, user_id, wallet, fn, occurred_at)
  values (p_network, pg_temp.tx(p_tx), pg_temp.uid(p_n), pg_temp.wallet('G', p_n), 'anchor', p_at)
$$;

-- An unpaid reward, written straight in: a paid one can't be.
create function pg_temp.reward(p_n int, p_referrer int, p_status text, p_amount int, p_qualified timestamptz,
                               p_reason text default null)
returns void language sql as $$
  insert into public.referral_rewards
    (network, referrer_user_id, referred_user_id, referred_wallet, amount_php, status, void_reason, qualified_at)
  values ('testnet', pg_temp.uid(p_referrer), pg_temp.uid(p_n), pg_temp.wallet('G', p_n), p_amount, p_status,
          case when p_status = 'void' then coalesce(p_reason, 'fraud') end, p_qualified)
$$;

-- By wallet, which outlives the referred user, and never the duplicate_wallet row.
create function pg_temp.rid(p_n int) returns uuid language sql as $$
  select id from public.referral_rewards
   where referred_wallet = pg_temp.wallet('G', p_n) and void_reason is distinct from 'duplicate_wallet'
$$;

create function pg_temp.details_at(p_referrer int) returns timestamptz language sql as $$
  select updated_at from public.referral_payout_profiles where user_id = pg_temp.uid(p_referrer)
$$;

-- What the queue says a referrer is owed: the sum of the stored amounts of the
-- eligible rewards it lists, as lib/referral-payouts.ts adds them.
create function pg_temp.owed(p_referrer int) returns int language sql as $$
  select coalesce(sum((e ->> 'amount_php')::int), 0)::int
    from public.referral_payout_queue() q, jsonb_array_elements(q.eligible_rewards) e
   where q.referrer_user_id = pg_temp.uid(p_referrer)
$$;

create function pg_temp.payouts() returns int language sql as $$
  select count(*)::int from public.referral_payouts
$$;

create function pg_temp.ids(p_rewards int[]) returns uuid[] language sql as $$
  select array_agg(pg_temp.rid(n) order by n) from unnest(p_rewards) n
$$;

-- The two steps as the route calls them, with the details as they stand, by
-- admin 9 unless told otherwise.
create function pg_temp.start(p_referrer int, p_rewards int[], p_amount int, p_admin int default 9)
returns jsonb language sql as $$
  select public.start_referral_payout(
    pg_temp.uid(p_referrer), pg_temp.ids(p_rewards), p_amount, pg_temp.details_at(p_referrer), pg_temp.uid(p_admin))
$$;

create function pg_temp.record(p_referrer int, p_rewards int[], p_amount int, p_reference text default null,
                               p_admin int default 9)
returns uuid language sql as $$
  select public.mark_referral_rewards_paid(
    pg_temp.uid(p_referrer), pg_temp.ids(p_rewards), p_amount, pg_temp.details_at(p_referrer), p_reference,
    pg_temp.uid(p_admin))
$$;

-- Both, as an admin pays: start, send by hand, record.
create function pg_temp.pay(p_referrer int, p_rewards int[], p_amount int, p_reference text default null)
returns uuid language plpgsql as $$
begin
  perform pg_temp.start(p_referrer, p_rewards, p_amount);
  return pg_temp.record(p_referrer, p_rewards, p_amount, p_reference);
end;
$$;

create function pg_temp.claims(p_referrer int) returns int language sql as $$
  select count(*)::int from public.referral_payout_claims where referrer_user_id = pg_temp.uid(p_referrer)
$$;

-- ---------------------------------------------------------------------------
-- Who can reach it
-- ---------------------------------------------------------------------------

select is((select relrowsecurity from pg_class where oid = 'public.referral_payouts'::regclass), true,
  'referral_payouts has RLS on');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'referral_payouts'), 0,
  'with no policies');
select is(
  (select count(*)::int
     from unnest(array['anon', 'authenticated']) as r(name),
          unnest(array['select', 'insert', 'update', 'delete']) as p(name)
    where has_table_privilege(r.name, 'public.referral_payouts', p.name)),
  0, 'anon and authenticated hold no privilege on the ledger');
select ok(has_table_privilege('service_role', 'public.referral_payouts', 'select'), 'the service role can read it');
select ok(not has_table_privilege('service_role', 'public.referral_payouts', 'insert')
          and not has_table_privilege('service_role', 'public.referral_payouts', 'update')
          and not has_table_privilege('service_role', 'public.referral_payouts', 'delete'),
  'but neither insert, change nor delete a row: only mark_referral_rewards_paid() writes there');
select is((select relrowsecurity from pg_class where oid = 'public.referral_payout_claims'::regclass), true,
  'referral_payout_claims has RLS on');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'referral_payout_claims'), 0,
  'with no policies');
select is(
  (select array_agg(r.name || ' ' || p.name order by r.name, p.name)
     from unnest(array['anon', 'authenticated', 'service_role']) as r(name),
          unnest(array['select', 'insert', 'update', 'delete']) as p(name)
    where has_table_privilege(r.name, 'public.referral_payout_claims', p.name)),
  array['service_role select'], 'on the claims, the service role may only read, and clients nothing');
select is(
  (select array_agg(column_name::text order by column_name::text)
     from information_schema.columns where table_schema = 'public' and table_name = 'referral_payouts'),
  array['amount_php', 'ewallet_provider', 'id', 'method', 'paid_at', 'paid_by', 'reference', 'referrer_user_id',
        'reward_count'],
  'the ledger has these columns: no address, account number, name or memo');

create temp table payout_fns as
  select p.oid, p.proname::text as name, p.prosecdef as definer, p.proconfig
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('start_referral_payout', 'release_referral_payout', 'mark_referral_rewards_paid',
                       'restore_referral_reward', 'referral_payout_queue', 'referral_payout_referrals',
                       'referral_payout_conflict', 'referral_rewards_paid_final', 'referral_payouts_keep',
                       'referral_payout_profiles_before_update', 'referral_payout_check_request',
                       'referral_payout_check_rewards', 'referral_payout_account_gone');
grant select on payout_fns to anon, authenticated, service_role;

select is((select count(*)::int from payout_fns), 13, 'the thirteen functions exist');
select is((select array_agg(name order by name) from payout_fns where definer),
  array['mark_referral_rewards_paid', 'referral_payout_conflict', 'referral_payout_queue', 'referral_payout_referrals',
        'release_referral_payout', 'start_referral_payout'],
  'the payout steps and the reads are security definer; restore and the helpers run as their caller');
select is((select array_agg(name) from payout_fns where not coalesce(proconfig @> array['search_path=""'], false)),
  null::text[], 'all have an empty search_path');
select is(
  (select array_agg(f.name) from payout_fns f, unnest(array['public', 'anon', 'authenticated']) as r(name)
    where has_function_privilege(r.name, f.oid, 'execute')),
  null::text[], 'no client can run any of them');
select is(
  (select array_agg(f.name order by f.name) from payout_fns f where has_function_privilege('service_role', f.oid, 'execute')),
  array['mark_referral_rewards_paid', 'referral_payout_conflict', 'referral_payout_queue', 'referral_payout_referrals',
        'release_referral_payout', 'restore_referral_reward', 'start_referral_payout'],
  'the service role can run all but the triggers and the internal helpers');
select matches(pg_get_functiondef('public.mark_referral_rewards_paid(uuid, uuid[], integer, timestamptz, text, uuid)'::regprocedure),
  'lock_referral_referrer', 'recording takes the referrer''s lock');
select matches(pg_get_functiondef('public.start_referral_payout(uuid, uuid[], integer, timestamptz, uuid)'::regprocedure),
  'lock_referral_referrer', 'so does starting');
select matches(pg_get_functiondef('public.release_referral_payout(uuid, uuid)'::regprocedure),
  'lock_referral_referrer', 'and releasing');
select matches(pg_get_functiondef('public.restore_referral_reward(uuid, integer)'::regprocedure),
  'lock_referral_referrer', 'and so does restoring');

set local role anon;
select throws_ok($$ select * from public.referral_payouts $$, '42501', null, 'anon can''t read the ledger');
select throws_ok($$ select * from public.referral_payout_queue() $$, '42501', null, 'or the queue');
select throws_ok($$ select public.mark_referral_rewards_paid(gen_random_uuid(), array[gen_random_uuid()], 30, now(), null, gen_random_uuid()) $$,
  '42501', null, 'or mark anything paid');
select throws_ok($$ select public.start_referral_payout(gen_random_uuid(), array[gen_random_uuid()], 30, now(), gen_random_uuid()) $$,
  '42501', null, 'or start a payout');
reset role;
set local role authenticated;
select throws_ok($$ select * from public.referral_payouts $$, '42501', null, 'a signed-in client can''t read the ledger');
select throws_ok($$ select * from public.referral_payout_referrals(gen_random_uuid(), 'testnet') $$, '42501', null,
  'or anyone''s referrals');
select throws_ok($$ select public.restore_referral_reward(gen_random_uuid(), 30) $$, '42501', null, 'or restore a reward');
reset role;

-- ---------------------------------------------------------------------------
-- Rows
-- ---------------------------------------------------------------------------

select pg_temp.add_user(9);  -- the admin
select pg_temp.add_user(1);
select pg_temp.add_user(2);
select pg_temp.add_user(3);
select pg_temp.add_user(4);

-- Referrer 1: four eligible (one stored at an older amount, one whose referred user
-- has since deleted their account), one over the limit, one void, one pending.
select pg_temp.refer(17, 1);
select pg_temp.reward(17, 1, 'eligible', 30, now() - interval '4 days');
select pg_temp.refer(11, 1, now() - interval '9 days');
select pg_temp.act(11, 1100, now() - interval '9 days 1 hour');  -- before the referral
select pg_temp.act(11, 1101, now() - interval '8 days');
select pg_temp.act(11, 1102, now() - interval '7 days');
select pg_temp.act(11, 1103, now() - interval '3 days');
select pg_temp.act(11, 1104, now() - interval '3 days', 'mainnet');  -- another network
select pg_temp.reward(11, 1, 'eligible', 30, now() - interval '3 days');
select pg_temp.refer(12, 1);
select pg_temp.reward(12, 1, 'eligible', 45, now() - interval '2 days');
select pg_temp.refer(13, 1);
select pg_temp.reward(13, 1, 'eligible', 30, now() - interval '1 day');
select pg_temp.refer(14, 1);
select pg_temp.reward(14, 1, 'over_limit', 30, now() - interval '12 hours');
select pg_temp.refer(15, 1);
select pg_temp.reward(15, 1, 'void', 30, now() - interval '20 hours', 'farmed account');
select pg_temp.refer(16, 1, now() - interval '5 days');
select pg_temp.act(16, 1601, now() - interval '6 days');
select pg_temp.act(16, 1602, now() - interval '4 days');
select pg_temp.act(16, 1603, now() - interval '4 days', 'mainnet');
delete from auth.users where id = pg_temp.uid(17);
insert into public.wallet_accounts (address, user_id) values (pg_temp.wallet('G', 1), pg_temp.uid(1));

-- Referrer 2: one eligible, paid to an e-wallet.
select pg_temp.refer(21, 2);
select pg_temp.reward(21, 2, 'eligible', 30, now() - interval '2 days');
-- Referrer 3: eligible, and no payout details.
select pg_temp.refer(31, 3);
select pg_temp.reward(31, 3, 'eligible', 30, now() - interval '2 days');
-- Referrer 4: nothing to act on, as a void that can't be restored is nothing.
select pg_temp.refer(41, 4);
select pg_temp.reward(41, 4, 'void', 30, now() - interval '2 days', 'duplicate_wallet');

set local role service_role;
-- Written as the route writes them. Referrer 1's details were saved before any reward.
insert into public.referral_payout_profiles (user_id, method, name, xlm_address, xlm_memo, xlm_memo_type, created_at, updated_at)
values (pg_temp.uid(1), 'xlm', 'Referrer One', pg_temp.wallet('G', 101), '4242', 'id',
        now() - interval '6 days', now() - interval '6 days');
insert into public.referral_payout_profiles (user_id, method, name, ewallet_provider, ewallet_account_name, ewallet_account_number)
values (pg_temp.uid(2), 'ewallet', 'Referrer Two', 'GCash', 'Referrer Two', '0917 555 0101');

-- ---------------------------------------------------------------------------
-- The queue (AC 2)
-- ---------------------------------------------------------------------------

select is(
  (select array_agg(referrer_user_id order by referrer_user_id) from public.referral_payout_queue()),
  array[pg_temp.uid(1), pg_temp.uid(2), pg_temp.uid(3)],
  'one row per referrer with something to act on; one with only a duplicate_wallet void has none');
select is(pg_temp.owed(1), 135,
  'amount owed is the sum of the stored amounts of the eligible rewards: over the limit and void excluded');
select is(
  (select array_agg((e ->> 'id')::uuid order by o)
     from public.referral_payout_queue() q, jsonb_array_elements(q.eligible_rewards) with ordinality as x(e, o)
    where q.referrer_user_id = pg_temp.uid(1)),
  array[pg_temp.rid(17), pg_temp.rid(11), pg_temp.rid(12), pg_temp.rid(13)],
  'the eligible rewards, oldest first, a deleted referred user''s among them');
select results_eq(
  $$ select email, g_wallet, over_limit_count, paid_count, void_count, reward_limit, method, name, xlm_address,
            xlm_memo, xlm_memo_type
       from public.referral_payout_queue() where referrer_user_id = pg_temp.uid(1) $$,
  $$ values ('user1@example.com'::text, pg_temp.wallet('G', 1), 1, 0, 1, null::int, 'xlm'::text, 'Referrer One'::text,
             pg_temp.wallet('G', 101), '4242'::text, 'id'::text) $$,
  'with the email, wallet, counts, no limit of its own, and the payout details in full');
select results_eq(
  $$ select ewallet_provider, ewallet_account_name, ewallet_account_number, details_created_at is not null
       from public.referral_payout_queue() where referrer_user_id = pg_temp.uid(2) $$,
  $$ values ('GCash'::text, 'Referrer Two'::text, '0917 555 0101'::text, true) $$,
  'an e-wallet''s details in full too');
select results_eq(
  $$ select method, details_created_at from public.referral_payout_queue() where referrer_user_id = pg_temp.uid(3) $$,
  $$ values (null::text, null::timestamptz) $$,
  'no details: nothing, for the app to show Waiting for details');

reset role;
select pg_temp.add_user(6);
select pg_temp.refer(61, 6);
select pg_temp.reward(61, 6, 'void', 30, now() - interval '2 days', 'farmed account');
set local role service_role;
select results_eq(
  $$ select void_count, jsonb_array_length(eligible_rewards), over_limit_count
       from public.referral_payout_queue() where referrer_user_id = pg_temp.uid(6) $$,
  $$ values (1, 0, 0) $$,
  'a referrer whose only reward is void, by an admin, stays in the queue so it can be restored');

-- ---------------------------------------------------------------------------
-- Review
-- ---------------------------------------------------------------------------

create temp table review on commit drop as select * from public.referral_payout_referrals(pg_temp.uid(1), 'testnet');

select is((select count(*)::int from review), 7,
  'every account referrer 1 referred: six still here and one reward-only row');
select results_eq(
  $$ select email, activity_count, reward_status, amount_php, former_user from review where email = 'user11@example.com' $$,
  $$ values ('user11@example.com'::text, 3, 'eligible'::text, 30, false) $$,
  'in full, with activity in DOQ-23''s window: this network, since the referral');
select results_eq(
  $$ select signed_up_at is not null, referred_at, qualified_at is not null
       from review where email = 'user11@example.com' $$,
  $$ select true, created_at, true from public.referrals where referred_user_id = pg_temp.uid(11) $$,
  'with when they signed up, were referred and qualified');
select results_eq(
  $$ select activity_count, reward_status, reward_id from review where email = 'user16@example.com' $$,
  $$ values (1, null::text, null::uuid) $$,
  'a referral still pending counts the app''s network from its referral');
select results_eq(
  $$ select reward_status, void_reason from review where email = 'user15@example.com' $$,
  $$ values ('void'::text, 'farmed account'::text) $$,
  'a void reward shows why');
select results_eq(
  $$ select email, referred_wallet, reward_status, former_user from review where former_user $$,
  $$ values (null::text, pg_temp.wallet('G', 17), 'eligible'::text, true) $$,
  'a deleted referred user is their reward alone, by its wallet');
select is(
  (select count(*)::int from public.referral_payout_referrals(pg_temp.uid(1), 'testnet') where email = 'user21@example.com'),
  0, 'another referrer''s referrals aren''t among them');

-- ---------------------------------------------------------------------------
-- Mark as paid: refusals (AC 5), and nothing written by any of them
-- ---------------------------------------------------------------------------

select throws_ok($$ select pg_temp.pay(1, array[17, 11], 61) $$, 'DQR02', null,
  'a total other than the one the rewards add up to is refused');
select throws_ok($$ select pg_temp.pay(1, array[17, 14], 60) $$, 'DQR02', null, 'an over-limit reward is refused');
select throws_ok($$ select pg_temp.pay(1, array[17, 15], 60) $$, 'DQR02', null, 'a void one is refused');
select throws_ok($$ select pg_temp.pay(1, array[17, 21], 60) $$, 'DQR02', null, 'another referrer''s is refused');
select throws_ok(
  $$ select public.mark_referral_rewards_paid(pg_temp.uid(1), array[pg_temp.rid(17), gen_random_uuid()], 60,
       pg_temp.details_at(1), null, pg_temp.uid(9)) $$,
  'DQR02', null, 'one that doesn''t exist is refused');
select throws_ok($$ select public.start_referral_payout(pg_temp.uid(3), pg_temp.ids(array[31]), 30, now(), pg_temp.uid(9)) $$,
  'DQR03', null, 'a referrer with no payout details is refused');
select throws_ok(
  $$ select public.mark_referral_rewards_paid(pg_temp.uid(1), array[pg_temp.rid(17)], 30,
       pg_temp.details_at(1) - interval '1 second', null, pg_temp.uid(9)) $$,
  'DQR04', null, 'details other than the ones the admin saw are refused');
select throws_ok(
  $$ select public.mark_referral_rewards_paid(pg_temp.uid(1), '{}', 30, pg_temp.details_at(1), null, pg_temp.uid(9)) $$,
  '22023', null, 'no rewards is refused');
select throws_ok($$ select pg_temp.pay(1, array[17, 17], 60) $$, '22023', null, 'and the same one twice');
select throws_ok(
  $$ select public.mark_referral_rewards_paid(pg_temp.uid(1), array[pg_temp.rid(17), null], 30, pg_temp.details_at(1), null, pg_temp.uid(9)) $$,
  '22023', null, 'and a null among them');
select throws_ok($$ select pg_temp.pay(1, array[17], 0) $$, '22023', null, 'a total of nothing is refused');
select throws_ok(
  $$ select public.mark_referral_rewards_paid(pg_temp.uid(1), array[pg_temp.rid(17)], 30, pg_temp.details_at(1), null, null) $$,
  '22023', null, 'no admin is refused');
select throws_ok($$ select pg_temp.pay(1, array[17], 30, repeat('a', 101)) $$, '22023', null,
  'a reference over 100 characters is refused');
select throws_ok($$ select pg_temp.pay(1, array[17], 30, E'ref\n123') $$, '22023', null,
  'and one with a line break inside');
select throws_ok($$ select pg_temp.pay(1, array[17], 30, U&'ref\200B123') $$, '22023', null,
  'and one with an invisible character');
select is(pg_temp.payouts(), 0, 'none of them wrote a payout');
select is(pg_temp.owed(1), 135, 'or paid anything');

-- ---------------------------------------------------------------------------
-- Mark as paid (AC 3)
-- ---------------------------------------------------------------------------

create temp table first_payout on commit drop as select pg_temp.pay(1, array[17, 11], 60, '  ab12cd34  ') as id;
grant select on first_payout to service_role;

select results_eq(
  $$ select referrer_user_id, paid_by, amount_php, reward_count, method, ewallet_provider, reference, paid_at is not null
       from public.referral_payouts where id = (select id from first_payout) $$,
  $$ values (pg_temp.uid(1), pg_temp.uid(9), 60, 2, 'xlm'::text, null::text, 'ab12cd34'::text, true) $$,
  'one payout: who, the admin, amount, count, method and the reference, trimmed');
select results_eq(
  $$ select status, payout_id from public.referral_rewards
      where id in (pg_temp.rid(17), pg_temp.rid(11)) order by qualified_at $$,
  $$ select 'paid'::text, id from first_payout union all select 'paid'::text, id from first_payout $$,
  'both rewards are paid, by it');
select is(pg_temp.owed(1), 75, 'and the amount owed drops by what was paid');
select is((select paid_count from public.referral_payout_queue() where referrer_user_id = pg_temp.uid(1)), 2,
  'the paid count rises');
select is(
  (select reward_status from public.referral_dashboard(pg_temp.uid(1), 'testnet') where email = 'user11@example.com'),
  'paid', 'and the referrer''s dashboard shows it Paid');
select throws_ok($$ select pg_temp.pay(1, array[17, 11], 60) $$, 'DQR02', null,
  'the same rewards again, as a second press would send them, are refused');
select is(pg_temp.payouts(), 1, 'so there is still one payout');
select throws_ok($$ select pg_temp.record(1, array[17, 11], 60) $$, 'DQR02', null,
  'recording them again, as a stale tab would, is refused as already paid, not as a missing claim');
select is(pg_temp.claims(1), 0, 'recording cleared the claim');

select lives_ok($$ select pg_temp.pay(2, array[21], 30, '   ') $$, 'an e-wallet payout, with a blank reference');
select results_eq(
  $$ select method, ewallet_provider, reference from public.referral_payouts where referrer_user_id = pg_temp.uid(2) $$,
  $$ values ('ewallet'::text, 'GCash'::text, null::text) $$,
  'records the provider, and no reference');

-- ---------------------------------------------------------------------------
-- When the details were first saved
-- ---------------------------------------------------------------------------

create temp table before_edit on commit drop as
  select created_at, updated_at from public.referral_payout_profiles where user_id = pg_temp.uid(1);
grant select on before_edit to service_role;
update public.referral_payout_profiles
   set name = 'Referrer One Edited', updated_at = now(), created_at = now()
 where user_id = pg_temp.uid(1);
select results_eq(
  $$ select created_at, updated_at > (select updated_at from before_edit)
       from public.referral_payout_profiles where user_id = pg_temp.uid(1) $$,
  $$ select created_at, true from before_edit $$,
  'an edit moves updated_at and never created_at, even when it tries');
select throws_ok(
  $$ select public.mark_referral_rewards_paid(pg_temp.uid(1), array[pg_temp.rid(12)], 45,
       (select updated_at from before_edit), null, pg_temp.uid(9)) $$,
  'DQR04', null, 'and the details as they were before the edit are refused');

-- The version is the database's: a writer that forgets updated_at, or sends an
-- old one, still makes a new one.
create temp table before_quiet on commit drop as
  select updated_at from public.referral_payout_profiles where user_id = pg_temp.uid(2);
grant select on before_quiet to service_role;
update public.referral_payout_profiles set ewallet_account_number = '0917 555 0199' where user_id = pg_temp.uid(2);
select ok((select updated_at from public.referral_payout_profiles where user_id = pg_temp.uid(2))
          > (select updated_at from before_quiet),
  'an edit that sends no updated_at still gets a new version');
update public.referral_payout_profiles set ewallet_details = 'Main branch', updated_at = (select updated_at from before_quiet)
 where user_id = pg_temp.uid(2);
select ok((select updated_at from public.referral_payout_profiles where user_id = pg_temp.uid(2))
          > (select updated_at from before_quiet),
  'and one that sends an old updated_at gets a new one anyway');

-- ---------------------------------------------------------------------------
-- Two steps: a claim, a competing admin, a mismatched claim, release, expiry
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.add_user(7);
select pg_temp.add_user(8);  -- a second admin
select pg_temp.refer(71, 7);
select pg_temp.reward(71, 7, 'eligible', 30, now() - interval '2 days');
select pg_temp.refer(72, 7);
select pg_temp.reward(72, 7, 'eligible', 30, now() - interval '1 day');
set local role service_role;
insert into public.referral_payout_profiles (user_id, method, name, xlm_address, xlm_memo, xlm_memo_type)
values (pg_temp.uid(7), 'xlm', 'Referrer Seven', pg_temp.wallet('G', 707), '77', 'id');

create temp table started on commit drop as select pg_temp.start(7, array[71, 72], 60) as d;
grant select on started to service_role;
select results_eq(
  $$ select d ->> 'method', d ->> 'name', d ->> 'xlm_address', d ->> 'xlm_memo',
            (d ->> 'details_updated_at')::timestamptz = pg_temp.details_at(7),
            (d ->> 'expires_at')::timestamptz - (d ->> 'claimed_at')::timestamptz
       from started $$,
  $$ values ('xlm'::text, 'Referrer Seven'::text, pg_temp.wallet('G', 707), '77'::text, true, interval '2 hours') $$,
  'starting returns the details as they are now, and holds the payout for 2 hours');
select results_eq(
  $$ select claimed_by, reward_ids, amount_php from public.referral_payout_claims where referrer_user_id = pg_temp.uid(7) $$,
  $$ values (pg_temp.uid(9), pg_temp.ids(array[71, 72]), 60) $$,
  'the claim is the admin''s, for exactly those rewards and that total');
select results_eq(
  $$ select claim_admin_id, claim_admin_email, claim_expires_at = (select (d ->> 'expires_at')::timestamptz from started)
       from public.referral_payout_queue() where referrer_user_id = pg_temp.uid(7) $$,
  $$ values (pg_temp.uid(9), 'user9@example.com'::text, true) $$,
  'the queue shows who is paying, and until when');
select throws_ok($$ select pg_temp.start(7, array[71, 72], 60, 8) $$, 'DQR07', null,
  'another admin can''t start a payout while one is live');
select is((public.referral_payout_conflict(pg_temp.uid(7), pg_temp.ids(array[71, 72])) -> 'claim' ->> 'admin_id')::uuid,
  pg_temp.uid(9), 'and can be told who holds it');
select throws_ok($$ select pg_temp.record(7, array[71, 72], 60, null, 8) $$, 'DQR08', null,
  'nor record one without a claim of their own');
select throws_ok($$ select pg_temp.record(7, array[71], 30) $$, 'DQR08', null,
  'the claiming admin can''t record other rewards than they claimed');
select is(pg_temp.payouts(), 2, 'none of that recorded anything');

update public.referral_payout_profiles set name = 'Referrer Seven Edited' where user_id = pg_temp.uid(7);
select throws_ok($$ select pg_temp.record(7, array[71, 72], 60) $$, 'DQR08', null,
  'the details edited after the claim: the claim no longer matches them');
select throws_ok(
  $$ select public.mark_referral_rewards_paid(pg_temp.uid(7), pg_temp.ids(array[71, 72]), 60,
       (select (d ->> 'details_updated_at')::timestamptz from started), null, pg_temp.uid(9)) $$,
  'DQR04', null, 'and recording with the claimed version is refused as changed');
select lives_ok($$ select pg_temp.start(7, array[71, 72], 60) $$,
  'starting again, with the new details, replaces the admin''s own claim');
select is(pg_temp.claims(7), 1, 'leaving one');

select is(public.release_referral_payout(pg_temp.uid(7), pg_temp.uid(8)), false, 'another admin can''t release it');
select is(public.release_referral_payout(pg_temp.uid(7), pg_temp.uid(9)), true, 'the claiming admin can');
select is(pg_temp.claims(7), 0, 'and then it''s gone');
select throws_ok($$ select pg_temp.record(7, array[71, 72], 60) $$, 'DQR08', null,
  'nothing can be recorded after releasing');

select lives_ok($$ select pg_temp.start(7, array[71, 72], 60, 8) $$, 'once released, another admin can start');
reset role;
update public.referral_payout_claims
   set claimed_at = now() - interval '3 hours', expires_at = now() - interval '1 hour'
 where referrer_user_id = pg_temp.uid(7);
set local role service_role;
select is((select claim_admin_id from public.referral_payout_queue() where referrer_user_id = pg_temp.uid(7)), null,
  'after 2 hours the claim has expired, and the queue shows nobody paying');
select throws_ok($$ select pg_temp.record(7, array[71, 72], 60, null, 8) $$, 'DQR08', null,
  'an expired claim records nothing');
select lives_ok($$ select pg_temp.start(7, array[71, 72], 60) $$, 'and another admin can start');
select results_eq(
  $$ select claimed_by, count(*)::int from public.referral_payout_claims
      where referrer_user_id = pg_temp.uid(7) group by claimed_by $$,
  $$ values (pg_temp.uid(9), 1) $$,
  'replacing the expired claim');
select lives_ok($$ select pg_temp.record(7, array[71, 72], 60, 'tx-77') $$, 'the claiming admin records the payout');
select is(pg_temp.claims(7), 0, 'which clears the claim');
select throws_ok($$ select pg_temp.record(7, array[71, 72], 60) $$, 'DQR02', null,
  'a second record of the same rewards is refused as already paid');
select throws_ok($$ select pg_temp.start(7, array[71, 72], 60, 8) $$, 'DQR02', null,
  'and so is starting them again');
select results_eq(
  $$ select jsonb_array_length(c -> 'paid'), (c -> 'paid' -> 0 ->> 'admin_id')::uuid, c -> 'paid' -> 0 ->> 'email',
            (c -> 'paid' -> 0 ->> 'amount_php')::int, (c -> 'paid' -> 0 ->> 'paid_at') is not null
       from (select public.referral_payout_conflict(pg_temp.uid(7), pg_temp.ids(array[71, 72])) as c) x $$,
  $$ values (1, pg_temp.uid(9), 'user9@example.com'::text, 60, true) $$,
  'the refusal can say who paid them, when and how much');

select throws_ok(
  $$ select public.start_referral_payout(pg_temp.uid(7), pg_temp.ids(array[71]), 30, pg_temp.details_at(7), gen_random_uuid()) $$,
  'DQR06', null, 'an admin whose account is gone can''t start a payout');
select throws_ok(
  $$ select public.mark_referral_rewards_paid(pg_temp.uid(7), pg_temp.ids(array[71]), 30, pg_temp.details_at(7), null,
       gen_random_uuid()) $$,
  'DQR06', null, 'or record one');
select throws_ok(
  $$ select public.start_referral_payout(gen_random_uuid(), pg_temp.ids(array[71]), 30, now(), pg_temp.uid(9)) $$,
  'DQR02', null, 'and a referrer whose account is gone is refused as changed');
select throws_ok(
  $$ select public.start_referral_payout(pg_temp.uid(7), pg_temp.ids(array[71]), 30, null, pg_temp.uid(9)) $$,
  '22023', null, 'starting needs the version of the details the admin saw');
select throws_ok(
  $$ insert into public.referral_payout_claims (referrer_user_id, claimed_by, reward_ids, amount_php, details_updated_at, expires_at)
     values (pg_temp.uid(7), pg_temp.uid(8), pg_temp.ids(array[71]), 30, now(), now() + interval '2 hours') $$,
  '42501', null, 'the service role can''t write a claim itself');

-- ---------------------------------------------------------------------------
-- Paid is final: every refused transition
-- ---------------------------------------------------------------------------

select throws_ok($$ update public.referral_rewards set status = 'eligible', payout_id = null where id = pg_temp.rid(11) $$,
  'DQR01', null, 'paid to eligible is refused');
select throws_ok($$ update public.referral_rewards set status = 'over_limit', payout_id = null where id = pg_temp.rid(11) $$,
  'DQR01', null, 'paid to over_limit is refused');
select throws_ok(
  $$ update public.referral_rewards set status = 'void', void_reason = 'fraud', payout_id = null where id = pg_temp.rid(11) $$,
  'DQR01', null, 'paid to void is refused');
select throws_ok($$ update public.referral_rewards set amount_php = 31 where id = pg_temp.rid(11) $$,
  'DQR01', null, 'a paid reward''s amount can''t change');
select throws_ok($$ update public.referral_rewards set payout_id = null where id = pg_temp.rid(11) $$,
  'DQR01', null, 'nor lose its payout');
select throws_ok(
  $$ update public.referral_rewards set payout_id = (select id from public.referral_payouts where referrer_user_id = pg_temp.uid(2))
      where id = pg_temp.rid(11) $$,
  'DQR01', null, 'nor move to another payout');
select throws_ok($$ update public.referral_rewards set referred_wallet = pg_temp.wallet('G', 999) where id = pg_temp.rid(11) $$,
  'DQR01', null, 'nor change wallet');
select throws_ok($$ update public.referral_rewards set qualified_at = now() where id = pg_temp.rid(11) $$,
  'DQR01', null, 'nor when it qualified');
select throws_ok($$ update public.referral_rewards set network = 'mainnet' where id = pg_temp.rid(11) $$,
  'DQR01', null, 'nor network');
select throws_ok($$ update public.referral_rewards set referrer_user_id = pg_temp.uid(2) where id = pg_temp.rid(11) $$,
  'DQR01', null, 'nor go to another referrer');
select throws_ok(
  $$ update public.referral_rewards set status = 'paid', payout_id = (select id from first_payout) where id = pg_temp.rid(12) $$,
  'DQR01', null, 'eligible to paid outside mark_referral_rewards_paid() is refused');
select throws_ok($$ update public.referral_rewards set payout_id = (select id from first_payout) where id = pg_temp.rid(12) $$,
  'DQR01', null, 'and so is giving an eligible reward a payout');
select throws_ok(
  $$ update public.referral_rewards set status = 'paid', payout_id = (select id from first_payout) where id = pg_temp.rid(15) $$,
  'DQR01', null, 'void to paid is refused');
select throws_ok(
  $$ select set_config('doqtri.paying_referral_rewards', 'on', true);
     update public.referral_rewards set status = 'paid', payout_id = (select id from first_payout) where id = pg_temp.rid(14) $$,
  'DQR01', null, 'over_limit to paid is refused, even with the flag mark_referral_rewards_paid() sets');
select is(current_setting('doqtri.paying_referral_rewards', true), '', 'the flag is off again after that refusal');
select throws_ok(
  $$ insert into public.referral_rewards (network, referrer_user_id, referred_wallet, amount_php, status, payout_id)
     values ('testnet', pg_temp.uid(1), pg_temp.wallet('G', 998), 30, 'paid', (select id from first_payout)) $$,
  'DQR01', null, 'a reward can''t be written paid');
select throws_ok(
  $$ delete from public.referral_payouts where id = (select id from first_payout) $$,
  '42501', null, 'the service role can''t delete a payout');
select throws_ok($$ delete from public.referral_rewards where id = pg_temp.rid(11) $$,
  'DQR01', null, 'nor a paid reward, which would free its wallet to earn again');
reset role;
select throws_ok($$ delete from public.referral_payouts where id = (select id from first_payout) $$,
  'DQR01', null, 'not even the table owner can delete a payout');
select throws_ok($$ delete from public.referral_rewards where id = pg_temp.rid(11) $$,
  'DQR01', null, 'or a paid reward');
select lives_ok($$ delete from public.referral_rewards where referred_user_id = pg_temp.uid(41) $$,
  'an unpaid reward can still be deleted');
select is((select count(*)::int from public.referral_rewards where referred_user_id = pg_temp.uid(41)), 0, 'and is');
set local role service_role;
select results_eq(
  $$ select status, amount_php, payout_id from public.referral_rewards where id = pg_temp.rid(11) $$,
  $$ select 'paid'::text, 30, id from first_payout $$,
  'the paid reward is as it was');
select is(public.void_referral_reward(pg_temp.rid(11), 'fraud', 30), false, 'void_referral_reward() can''t void it');
select is(public.restore_referral_reward(pg_temp.rid(11), 30), null, 'and there is nothing to restore');

-- ---------------------------------------------------------------------------
-- Void and restore (AC 6)
-- ---------------------------------------------------------------------------

select throws_ok($$ select public.void_referral_reward(pg_temp.rid(13), '', 30) $$, '22023', null, 'a void needs a reason');
select is(public.void_referral_reward(pg_temp.rid(13), 'self-referral', 30), true, 'voiding an eligible reward works');
select is(pg_temp.owed(1), 75, 'and takes it out of the amount owed, where the over-limit reward takes its place');
select is((select status from public.referral_rewards where id = pg_temp.rid(14)), 'eligible',
  'the oldest over-limit reward having moved up into the freed place');
select is(public.restore_referral_reward(pg_temp.rid(13), 30), 'eligible', 'restoring it, with a place, makes it eligible');
select results_eq(
  $$ select status, void_reason from public.referral_rewards where id = pg_temp.rid(13) $$,
  $$ values ('eligible'::text, null::text) $$, 'with its reason cleared');
select is(pg_temp.owed(1), 105, 'and back in the amount owed');
select is(public.restore_referral_reward(pg_temp.rid(13), 30), null, 'an eligible reward isn''t restored');
select is(public.restore_referral_reward(gen_random_uuid(), 30), null, 'nor one that doesn''t exist');

reset role;
insert into public.referral_rewards (network, referrer_user_id, referred_wallet, amount_php, status, void_reason)
values ('testnet', pg_temp.uid(1), pg_temp.wallet('G', 12), 30, 'void', 'duplicate_wallet');
set local role service_role;
select throws_ok(
  $$ select public.restore_referral_reward(
       (select id from public.referral_rewards where void_reason = 'duplicate_wallet' and referrer_user_id = pg_temp.uid(1)), 30) $$,
  'DQR05', null, 'a reward void as duplicate_wallet can''t be restored: its wallet has already earned');

-- At the limit, a restored reward waits over the limit.
select public.set_referral_reward_limit(pg_temp.uid(1), 4, 30);
select is(public.restore_referral_reward(pg_temp.rid(15), 30), 'over_limit',
  'restoring with no place left makes it over_limit');
select is((select over_limit_count from public.referral_payout_queue() where referrer_user_id = pg_temp.uid(1)), 1,
  'and the queue counts it there');
select is((select reward_limit from public.referral_payout_queue() where referrer_user_id = pg_temp.uid(1)), 4,
  'with the referrer''s own limit');

-- ---------------------------------------------------------------------------
-- Raising and lowering a limit (AC 7)
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.add_user(5);
insert into public.referral_rewards (network, referrer_user_id, referred_wallet, amount_php, status, qualified_at)
select 'testnet', pg_temp.uid(5), pg_temp.wallet('G', 5000 + n), 30, 'eligible', now() - make_interval(days => 60 - n)
  from generate_series(1, 30) n;
insert into public.referral_rewards (network, referrer_user_id, referred_wallet, amount_php, status, qualified_at)
values ('testnet', pg_temp.uid(5), pg_temp.wallet('G', 5101), 30, 'over_limit', now() - interval '2 days'),
       ('testnet', pg_temp.uid(5), pg_temp.wallet('G', 5102), 30, 'over_limit', now() - interval '1 day');
set local role service_role;

select public.set_referral_reward_limit(pg_temp.uid(5), 31, 30);
select is((select status from public.referral_rewards where referred_wallet = pg_temp.wallet('G', 5101)), 'eligible',
  'raising a limit from 30 to 31 moves the oldest over-limit reward to eligible');
select is((select status from public.referral_rewards where referred_wallet = pg_temp.wallet('G', 5102)), 'over_limit',
  'and only that one');
select is(pg_temp.owed(5), 31 * 30, 'which the amount owed now counts');
select public.set_referral_reward_limit(pg_temp.uid(5), 5, 30);
select is((select count(*)::int from public.referral_rewards where referrer_user_id = pg_temp.uid(5) and status = 'eligible'),
  31, 'lowering it never demotes an eligible reward');
select is(public.void_referral_reward(
            (select id from public.referral_rewards where referred_wallet = pg_temp.wallet('G', 5001)), 'fraud', 30),
  true, 'a void under a lowered limit works');
select is((select status from public.referral_rewards where referred_wallet = pg_temp.wallet('G', 5102)), 'over_limit',
  'and moves nothing up while still over it');

-- ---------------------------------------------------------------------------
-- Deleting the referrer, and the admin, after a payout
-- ---------------------------------------------------------------------------

reset role;
-- The referred user goes first: the set null on a paid reward is allowed.
select lives_ok($$ delete from auth.users where id = pg_temp.uid(11) $$, 'a paid reward''s referred user deletes themselves');
select results_eq(
  $$ select referred_user_id, status from public.referral_rewards where referred_wallet = pg_temp.wallet('G', 11) $$,
  $$ values (null::uuid, 'paid'::text) $$, 'and the reward stays paid');

select lives_ok($$ delete from auth.users where id = pg_temp.uid(1) $$, 'a referrer who has been paid deletes themselves');
select results_eq(
  $$ select referrer_user_id, paid_by, amount_php, reward_count, method, reference
       from public.referral_payouts where id = (select id from first_payout) $$,
  $$ values (null::uuid, pg_temp.uid(9), 60, 2, 'xlm'::text, 'ab12cd34'::text) $$,
  'the payout stays as the accounting record, naming no referrer');
select results_eq(
  $$ select referrer_user_id, status, payout_id from public.referral_rewards
      where referred_wallet in (pg_temp.wallet('G', 17), pg_temp.wallet('G', 11)) $$,
  $$ select null::uuid, 'paid'::text, id from first_payout union all select null::uuid, 'paid'::text, id from first_payout $$,
  'its rewards stay paid, by it');
select results_eq(
  $$ select status, void_reason from public.referral_rewards
      where referred_wallet in (pg_temp.wallet('G', 12), pg_temp.wallet('G', 13), pg_temp.wallet('G', 14))
        and void_reason is distinct from 'duplicate_wallet'
      order by referred_wallet $$,
  $$ values ('void'::text, 'referrer_deleted'::text), ('void'::text, 'referrer_deleted'::text),
            ('void'::text, 'referrer_deleted'::text) $$,
  'while the unpaid ones are voided, as DOQ-23''s trigger does');
set local role service_role;
select throws_ok($$ select public.restore_referral_reward(pg_temp.rid(12), 30) $$, 'DQR05', null,
  'which can''t be restored: there is nobody to pay');
select throws_ok(
  $$ select public.restore_referral_reward(
       (select id from public.referral_rewards where referred_wallet = pg_temp.wallet('G', 13)), 30) $$,
  'DQR05', null, 'none of them');
select is((select count(*)::int from public.referral_payout_queue() where referrer_user_id = pg_temp.uid(1)), 0,
  'and the referrer leaves the queue');
reset role;

select lives_ok($$ delete from auth.users where id = pg_temp.uid(9) $$, 'the admin who recorded payouts deletes themselves');
select is((select count(*)::int from public.referral_payouts where paid_by is not null), 0,
  'and every payout stays, naming no admin');
select is(pg_temp.payouts(), 3, 'all three payouts are still there');
select is(
  (select count(*)::int from public.referral_payouts
    where referrer_user_id in (pg_temp.uid(1), pg_temp.uid(9)) or paid_by in (pg_temp.uid(1), pg_temp.uid(9))),
  0, 'no payout names either deleted account');

select * from finish();
rollback;
