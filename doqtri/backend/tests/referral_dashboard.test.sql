-- pgTAP tests for 20261107110000_referral_dashboard.sql (WP-4.6, DOQ-24, D-111):
-- only the service role can run it, it returns nothing that identifies beyond
-- what the app masks, one referrer can't see another's rows, activity follows
-- DOQ-23's window, and a deleted referred user leaves a bare reward row.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/referral_dashboard.test.sql
--
-- Everything runs in one transaction that is rolled back. Rows are written as
-- the table owner; the function runs as the service role, as the app calls it.

begin;
create extension if not exists pgtap with schema extensions;

select plan(31);

create function pg_temp.uid(p_n int) returns uuid language sql immutable as $$
  select ('61000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;

-- A wallet address of the given kind for a number; 0, 1, 8 and 9 aren't base32.
create function pg_temp.wallet(p_kind text, p_n int) returns text language sql immutable as $$
  select p_kind || lpad(translate(p_n::text, '0189', 'ABCD'), 55, 'A')
$$;

create function pg_temp.tx(p_n int) returns text language sql immutable as $$
  select lpad(to_hex(p_n), 64, '0')
$$;

create function pg_temp.add_user(p_n int, p_email text default null) returns void language sql as $$
  insert into auth.users (id, email)
  values (pg_temp.uid(p_n), coalesce(p_email, 'user' || p_n || '@example.com'))
$$;

create function pg_temp.refer(p_n int, p_referrer int, p_at timestamptz, p_email text default null)
returns void language plpgsql as $$
begin
  perform pg_temp.add_user(p_n, p_email);
  insert into public.referrals (referred_user_id, referrer_user_id, code, source, created_at)
  values (pg_temp.uid(p_n), pg_temp.uid(p_referrer), 'abcdefgh', 'qr', p_at);
end;
$$;

create function pg_temp.act(p_n int, p_tx int, p_at timestamptz, p_network text default 'testnet')
returns void language sql as $$
  insert into public.referral_chain_activity (network, tx_hash, user_id, wallet, fn, occurred_at)
  values (p_network, pg_temp.tx(p_tx), pg_temp.uid(p_n), pg_temp.wallet('G', p_n), 'anchor', p_at)
$$;

create function pg_temp.reward(p_n int, p_referrer int, p_status text, p_amount int, p_network text default 'testnet')
returns void language sql as $$
  insert into public.referral_rewards
    (network, referrer_user_id, referred_user_id, referred_wallet, amount_php, status, void_reason)
  values (p_network, pg_temp.uid(p_referrer), pg_temp.uid(p_n), pg_temp.wallet('G', p_n), p_amount, p_status,
          case when p_status = 'void' then 'admin says no' end)
$$;

-- ---------------------------------------------------------------------------
-- Who can run it, and what it returns
-- ---------------------------------------------------------------------------

select has_function('public', 'referral_dashboard', array['uuid', 'text'], 'the function exists');
select is(
  (select prosecdef from pg_proc where oid = 'public.referral_dashboard(uuid, text)'::regprocedure),
  true, 'it is security definer, to read auth.users');
select is(
  (select proconfig from pg_proc where oid = 'public.referral_dashboard(uuid, text)'::regprocedure),
  array['search_path=""'], 'with an empty search_path');
select ok(has_function_privilege('service_role', 'public.referral_dashboard(uuid, text)', 'execute'),
  'the service role can run it');
select ok(not has_function_privilege('anon', 'public.referral_dashboard(uuid, text)', 'execute'), 'anon can''t');
select ok(not has_function_privilege('authenticated', 'public.referral_dashboard(uuid, text)', 'execute'),
  'nor can a signed-in client');
select ok(not has_function_privilege('public', 'public.referral_dashboard(uuid, text)', 'execute'), 'nor public');

select is(
  (select array_agg(c order by c)
     from unnest((select proargnames from pg_proc where oid = 'public.referral_dashboard(uuid, text)'::regprocedure)) c
    where c not like 'p\_%'),
  array['activity_count', 'amount_php', 'c_wallet', 'email', 'former_user', 'g_wallet', 'referred_at',
        'reward_status', 'source'],
  'it returns these columns and no others: no id, display name, hash, referred_wallet or void reason');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and tablename in ('referrals', 'referral_chain_activity', 'referral_rewards', 'referral_reward_limits')),
  0, 'the tables have no policies: still service role only');

set local role anon;
select throws_ok($$ select * from public.referral_dashboard(pg_temp.uid(1), 'testnet') $$, '42501', null,
  'anon is refused when it tries');
reset role;
set local role authenticated;
select throws_ok($$ select * from public.referral_dashboard(pg_temp.uid(1), 'testnet') $$, '42501', null,
  'and so is a signed-in client');
reset role;

-- ---------------------------------------------------------------------------
-- Rows
-- ---------------------------------------------------------------------------

select pg_temp.add_user(1);
select pg_temp.add_user(2);

-- Referrer 1. Referred an hour ago, unless a test needs otherwise.
select pg_temp.refer(11, 1, now() - interval '11 hours', 'tycoon@gmail.com');
select pg_temp.act(11, 1101, now() - interval '12 hours');  -- before the referral
select pg_temp.act(11, 1102, now() - interval '11 hours');  -- at it: counts
select pg_temp.act(11, 1103, now() - interval '1 hour');
select pg_temp.act(11, 1104, now() - interval '1 hour', 'mainnet');  -- another network

-- A wallet login.
select pg_temp.refer(12, 1, now() - interval '12 hours', lower(pg_temp.wallet('G', 12)) || '@stellar.doqtri.local');
insert into public.wallet_accounts (address, user_id) values (pg_temp.wallet('G', 12), pg_temp.uid(12));
select pg_temp.reward(12, 1, 'eligible', 30);

-- A passkey wallet on each network.
select pg_temp.refer(13, 1, now() - interval '13 hours');
insert into public.smart_wallets (user_id, network, address, created_tx) values
  (pg_temp.uid(13), 'testnet', pg_temp.wallet('C', 131), pg_temp.tx(13101)),
  (pg_temp.uid(13), 'mainnet', pg_temp.wallet('C', 132), pg_temp.tx(13102));
select pg_temp.reward(13, 1, 'paid', 45);

select pg_temp.refer(14, 1, now() - interval '14 hours');
select pg_temp.reward(14, 1, 'over_limit', 30);

select pg_temp.refer(15, 1, now() - interval '15 hours');
select pg_temp.reward(15, 1, 'void', 30);

-- Referred, earned, then deleted the account.
select pg_temp.refer(16, 1, now() - interval '16 hours');
select pg_temp.act(16, 1601, now() - interval '3 hours');
select pg_temp.reward(16, 1, 'eligible', 30);
update public.referral_rewards set qualified_at = now() - interval '30 minutes' where referred_user_id = pg_temp.uid(16);
delete from auth.users where id = pg_temp.uid(16);

-- Referred, with a reward on the other network only.
select pg_temp.refer(17, 1, now() - interval '17 hours');
select pg_temp.reward(17, 1, 'paid', 99, 'mainnet');

-- Referrer 2's.
select pg_temp.refer(21, 2, now() - interval '5 minutes', 'other@example.com');
select pg_temp.act(21, 2101, now());
select pg_temp.reward(21, 2, 'eligible', 30);

set local role service_role;
create temp table one on commit drop as select * from public.referral_dashboard(pg_temp.uid(1), 'testnet');
create temp table two on commit drop as select * from public.referral_dashboard(pg_temp.uid(2), 'testnet');
create temp table none on commit drop as select * from public.referral_dashboard(pg_temp.uid(3), 'testnet');
create temp table main on commit drop as select * from public.referral_dashboard(pg_temp.uid(1), 'mainnet');
reset role;

select is((select count(*)::int from one), 7, 'referrer 1 has all seven of theirs on this network');
select is((select count(*)::int from two), 1, 'referrer 2 has one');
select is((select count(*)::int from none), 0, 'someone who referred nobody has none');
select is((select count(*)::int from one where email = 'other@example.com'), 0,
  'referrer 1 can''t see referrer 2''s referral');
select is((select array_agg(email) from two), array['other@example.com'], 'and referrer 2 sees only it');

select results_eq(
  $$ select email from one where email is not null order by referred_at desc $$,
  $$ values ('tycoon@gmail.com'), (lower(pg_temp.wallet('G', 12)) || '@stellar.doqtri.local'),
            ('user13@example.com'), ('user14@example.com'), ('user15@example.com'), ('user17@example.com') $$,
  'the living, by referral date');
select is(
  (select array_agg(former_user) from public.referral_dashboard(pg_temp.uid(1), 'testnet')),
  array[true, false, false, false, false, false, false],
  'newest first: the former user''s row dates from when the reward qualified');

select results_eq(
  $$ select activity_count, source from one where email = 'tycoon@gmail.com' $$,
  $$ values (2, 'qr'::text) $$,
  'activity counts from the referral on, this network only');
select is((select count(*)::int from main where email = 'tycoon@gmail.com' and activity_count = 1), 1,
  'and on the other network, that network''s');
select is((select reward_status from one where email = 'tycoon@gmail.com'), null, 'no reward yet, no status');

select results_eq(
  $$ select g_wallet, c_wallet, reward_status, amount_php from one
      where email like '%@stellar.doqtri.local' $$,
  $$ values (pg_temp.wallet('G', 12), null::text, 'eligible'::text, 30) $$,
  'a wallet login comes with its wallet and reward');
select results_eq(
  $$ select g_wallet, c_wallet, reward_status, amount_php from one where email = 'user13@example.com' $$,
  $$ values (null::text, pg_temp.wallet('C', 131), 'paid'::text, 45) $$,
  'a passkey wallet with this network''s address and the amount stored');
select is((select c_wallet from main where email = 'user13@example.com'), pg_temp.wallet('C', 132),
  'and the other network''s address on that one');
select is((select reward_status from one where email = 'user14@example.com'), 'over_limit', 'over limit stays so');
select is((select reward_status from one where email = 'user15@example.com'), 'void', 'void stays so');

select results_eq(
  $$ select email, g_wallet, c_wallet, source, activity_count, reward_status, amount_php from one where former_user $$,
  $$ values (null::text, null::text, null::text, null::text, null::int, 'eligible'::text, 30) $$,
  'a deleted referred user leaves only their reward: no identity, not even its wallet');
select is(
  (select extract(epoch from now() - referred_at)::int from one where former_user), 30 * 60,
  'dated when it qualified, the only date left');

select results_eq(
  $$ select reward_status, amount_php from one where email = 'user17@example.com' $$,
  $$ values (null::text, null::int) $$,
  'a reward on another network doesn''t show on this one');
select is((select amount_php from main where email = 'user17@example.com'), 99, 'it shows on its own');

-- A reward someone else holds on a referral of mine stays theirs.
update public.referral_rewards set referrer_user_id = pg_temp.uid(2) where referred_user_id = pg_temp.uid(14);
set local role service_role;
select is(
  (select reward_status from public.referral_dashboard(pg_temp.uid(1), 'testnet') where email = 'user14@example.com'),
  null, 'another referrer''s reward isn''t shown as this one''s');
reset role;

select * from finish();
rollback;
