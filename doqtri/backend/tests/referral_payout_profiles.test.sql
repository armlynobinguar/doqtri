-- pgTAP tests for 20261107120000_referral_payout_profiles.sql (WP-4.6, DOQ-25,
-- D-112): the owner can read their row and nobody else can, nobody but the
-- service role can write, a row holds one method's details only, the column
-- checks back the app's validator, and the row goes with the account.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/referral_payout_profiles.test.sql
--
-- One transaction, rolled back. Users are signed in by switching to the
-- authenticated role with their id in the JWT claims (auth.uid()).
--
-- Cast:
--   o  the owner, with XLM details
--   s  someone else, with e-wallet details of their own

begin;
create extension if not exists pgtap with schema extensions;

select plan(48);

create function pg_temp.uid(p_n int) returns uuid language sql immutable as $$
  select ('62000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;

-- A real-looking address: the table checks the shape, the app the checksum.
create function pg_temp.g(p_letter text) returns text language sql immutable as $$
  select 'G' || repeat(p_letter, 55)
$$;

insert into auth.users (id, email) values
  (pg_temp.uid(1), 'owner@example.com'),
  (pg_temp.uid(2), 'someone@example.com');

insert into public.referral_payout_profiles (user_id, method, name, xlm_address, xlm_memo)
values (pg_temp.uid(1), 'xlm', 'Owner Name', pg_temp.g('A'), '12345');
insert into public.referral_payout_profiles
  (user_id, method, name, ewallet_provider, ewallet_account_name, ewallet_account_number)
values (pg_temp.uid(2), 'ewallet', 'Someone Else', 'GCash', 'Someone Else', '09171234567');

-- ---------------------------------------------------------------------------
-- The table and who may touch it
-- ---------------------------------------------------------------------------

select has_table('public', 'referral_payout_profiles', 'the table exists');
select col_is_pk('public', 'referral_payout_profiles', 'user_id', 'one row per user');
select is((select relrowsecurity from pg_class where oid = 'public.referral_payout_profiles'::regclass),
  true, 'RLS is on');
select policies_are('public', 'referral_payout_profiles', array['Owners can read their payout profile'],
  'one policy, and it is the owner''s read');
select is(
  (select cmd from pg_policies where schemaname = 'public' and tablename = 'referral_payout_profiles'),
  'SELECT', 'which is for select only');

select ok(not has_table_privilege('anon', 'public.referral_payout_profiles', 'select'), 'anon can''t read');
select ok(not has_table_privilege('anon', 'public.referral_payout_profiles', 'insert, update, delete'),
  'nor write');
select ok(has_table_privilege('authenticated', 'public.referral_payout_profiles', 'select'),
  'a signed-in user may select, for RLS to filter');
select ok(not has_table_privilege('authenticated', 'public.referral_payout_profiles', 'insert'),
  'but not insert');
select ok(not has_table_privilege('authenticated', 'public.referral_payout_profiles', 'update'), 'nor update');
select ok(not has_table_privilege('authenticated', 'public.referral_payout_profiles', 'delete'), 'nor delete');
select ok(has_table_privilege('service_role', 'public.referral_payout_profiles', 'select, insert, update, delete'),
  'the service role can do all four, for the route');

-- ---------------------------------------------------------------------------
-- The owner (AC 6)
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"62000000-0000-4000-8000-000000000001","role":"authenticated"}';

select results_eq(
  $$ select user_id, method, name, xlm_address, xlm_memo from public.referral_payout_profiles $$,
  $$ values ('62000000-0000-4000-8000-000000000001'::uuid, 'xlm'::text, 'Owner Name'::text,
             'G' || repeat('A', 55), '12345'::text) $$,
  'the owner reads their own row, and only that');
select throws_ok(
  $$ update public.referral_payout_profiles set name = 'Changed' $$,
  '42501', null, 'the owner can''t change it directly');
select throws_ok(
  $$ delete from public.referral_payout_profiles $$,
  '42501', null, 'nor delete it');
select throws_ok(
  $$ insert into public.referral_payout_profiles (user_id, method, name, xlm_address)
     values ('62000000-0000-4000-8000-000000000001', 'xlm', 'Owner Name', 'G' || repeat('B', 55))
     on conflict (user_id) do update set xlm_address = excluded.xlm_address $$,
  '42501', null, 'nor upsert it');

-- ---------------------------------------------------------------------------
-- Someone else (AC 6)
-- ---------------------------------------------------------------------------

set local request.jwt.claims to '{"sub":"62000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::int from public.referral_payout_profiles where user_id = pg_temp.uid(1)),
  0, 'another user can''t read the owner''s row');
select is((select count(*)::int from public.referral_payout_profiles), 1, 'they see their own only');
select throws_ok(
  $$ update public.referral_payout_profiles set name = 'Taken' where user_id = '62000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'nor change the owner''s');
select throws_ok(
  $$ delete from public.referral_payout_profiles where user_id = '62000000-0000-4000-8000-000000000001' $$,
  '42501', null, 'nor delete it');
select throws_ok(
  $$ insert into public.referral_payout_profiles (user_id, method, name, xlm_address)
     values ('62000000-0000-4000-8000-000000000001', 'xlm', 'Taken', 'G' || repeat('C', 55)) $$,
  '42501', null, 'nor write one in the owner''s name');

-- With no session at all, the same signed-in role still reads nothing.
set local request.jwt.claims to '';
select is((select count(*)::int from public.referral_payout_profiles), 0,
  'a signed-in role with no user id reads nothing');

reset role;

-- Should a write grant ever be added by mistake, RLS still has no write policy.
grant insert, update, delete on public.referral_payout_profiles to authenticated;
set local role authenticated;
set local request.jwt.claims to '{"sub":"62000000-0000-4000-8000-000000000002","role":"authenticated"}';
update public.referral_payout_profiles set name = 'Taken' where user_id = pg_temp.uid(1);
delete from public.referral_payout_profiles where user_id = pg_temp.uid(1);
select throws_ok(
  $$ insert into public.referral_payout_profiles (user_id, method, name, xlm_address)
     values ('62000000-0000-4000-8000-000000000002', 'xlm', 'Mine', 'G' || repeat('D', 55))
     on conflict (user_id) do nothing $$,
  '42501', null, 'even with a grant, RLS refuses an insert');
reset role;
revoke insert, update, delete on public.referral_payout_profiles from authenticated;
select results_eq(
  $$ select name from public.referral_payout_profiles where user_id = '62000000-0000-4000-8000-000000000001' $$,
  $$ values ('Owner Name'::text) $$,
  'and an update or delete of someone else''s row changes nothing');

-- ---------------------------------------------------------------------------
-- anon (AC 6)
-- ---------------------------------------------------------------------------

set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$ select * from public.referral_payout_profiles $$, '42501', null, 'anon can''t read it');
select throws_ok(
  $$ insert into public.referral_payout_profiles (user_id, method, name, xlm_address)
     values ('62000000-0000-4000-8000-000000000003', 'xlm', 'Nobody', 'G' || repeat('E', 55)) $$,
  '42501', null, 'nor write');
reset role;

-- ---------------------------------------------------------------------------
-- The service role, as the route writes
-- ---------------------------------------------------------------------------

set local role service_role;

select lives_ok(
  $$ insert into public.referral_payout_profiles
       (user_id, method, name, xlm_address, xlm_memo, ewallet_provider, ewallet_account_name,
        ewallet_account_number, ewallet_details, updated_at)
     values ('62000000-0000-4000-8000-000000000001', 'ewallet', 'Owner Name', null, null, 'Maya',
             'Owner Name', '0917 000 1111', 'Main branch', now())
     on conflict (user_id) do update set
       method = excluded.method, name = excluded.name, xlm_address = excluded.xlm_address,
       xlm_memo = excluded.xlm_memo, ewallet_provider = excluded.ewallet_provider,
       ewallet_account_name = excluded.ewallet_account_name,
       ewallet_account_number = excluded.ewallet_account_number,
       ewallet_details = excluded.ewallet_details, updated_at = excluded.updated_at $$,
  'the service role switches the owner to e-wallet, writing every column as the route does');
select results_eq(
  $$ select method, xlm_address, xlm_memo, ewallet_provider, ewallet_account_number
       from public.referral_payout_profiles where user_id = '62000000-0000-4000-8000-000000000001' $$,
  $$ values ('ewallet'::text, null::text, null::text, 'Maya'::text, '0917 000 1111'::text) $$,
  'and the XLM details are gone (AC 4)');

-- ---------------------------------------------------------------------------
-- One method's details only (AC 4), and the column checks
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ update public.referral_payout_profiles set method = 'xlm', xlm_address = 'G' || repeat('A', 55)
      where user_id = '62000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'switching to XLM with the e-wallet details left behind is refused');
select throws_ok(
  $$ update public.referral_payout_profiles set xlm_memo = '12345'
      where user_id = '62000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'so is an XLM memo on an e-wallet row');
select throws_ok(
  $$ insert into public.referral_payout_profiles (user_id, method, name, xlm_address, ewallet_provider)
     values ('62000000-0000-4000-8000-000000000002', 'xlm', 'Mixed', 'G' || repeat('A', 55), 'GCash')
     on conflict (user_id) do update set method = excluded.method, xlm_address = excluded.xlm_address,
       ewallet_provider = excluded.ewallet_provider $$,
  '23514', null, 'an XLM row with an e-wallet provider is refused');
select throws_ok(
  $$ update public.referral_payout_profiles set ewallet_account_number = null
      where user_id = '62000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'an e-wallet row needs its number');
select throws_ok(
  $$ update public.referral_payout_profiles
        set method = 'xlm', ewallet_provider = null, ewallet_account_name = null, ewallet_account_number = null
      where user_id = '62000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'an XLM row needs its address');
select throws_ok(
  $$ update public.referral_payout_profiles set method = 'cash' where user_id = '62000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'and there are only two methods');

create function pg_temp.xlm(p_address text, p_memo text default null, p_name text default 'Owner Name')
returns void language sql as $$
  update public.referral_payout_profiles
     set method = 'xlm', name = p_name, xlm_address = p_address, xlm_memo = p_memo,
         ewallet_provider = null, ewallet_account_name = null, ewallet_account_number = null, ewallet_details = null
   where user_id = '62000000-0000-4000-8000-000000000001'
$$;

select lives_ok($$ select pg_temp.xlm('G' || repeat('B', 55)) $$, 'switching back to XLM, cleanly, is fine');
select throws_ok($$ select pg_temp.xlm('C' || repeat('B', 55)) $$, '23514', null,
  'a passkey (C...) address is refused');
select throws_ok($$ select pg_temp.xlm('G' || repeat('B', 54)) $$, '23514', null, 'so is one too short');
select throws_ok($$ select pg_temp.xlm(lower('G' || repeat('B', 55))) $$, '23514', null, 'or in lower case');
select lives_ok($$ select pg_temp.xlm('G' || repeat('B', 55), repeat('x', 28)) $$, 'a 28-byte memo is fine');
select throws_ok($$ select pg_temp.xlm('G' || repeat('B', 55), repeat('x', 29)) $$, '23514', null,
  'a 29-byte one isn''t');
-- 'é' is two bytes: 14 of them are 28 bytes, in 14 characters.
select lives_ok($$ select pg_temp.xlm('G' || repeat('B', 55), repeat('é', 14)) $$,
  'fourteen two-byte characters are 28 bytes, and fine');
select throws_ok($$ select pg_temp.xlm('G' || repeat('B', 55), repeat('é', 14) || 'x') $$, '23514', null,
  'one more byte, in fifteen characters, is refused: bytes count, not characters');
select throws_ok($$ select pg_temp.xlm('G' || repeat('B', 55), '') $$, '23514', null,
  'an empty memo is stored as null, never as empty');
select throws_ok($$ select pg_temp.xlm('G' || repeat('B', 55), null, E'Owner\nName') $$, '23514', null,
  'a line break in a name is refused');
select throws_ok($$ select pg_temp.xlm('G' || repeat('B', 55), null, repeat('n', 101)) $$, '23514', null,
  'so is a name over 100 characters');
select throws_ok(
  $$ update public.referral_payout_profiles set ewallet_account_number = 'no digits here'
      where user_id = '62000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'an account number needs a digit');

reset role;

-- ---------------------------------------------------------------------------
-- The account goes, and the row with it (AC 7)
-- ---------------------------------------------------------------------------

delete from auth.users where id = pg_temp.uid(1);
select is((select count(*)::int from public.referral_payout_profiles where user_id = pg_temp.uid(1)), 0,
  'deleting the account deletes its payout details');
select is((select count(*)::int from public.referral_payout_profiles where user_id = pg_temp.uid(2)), 1,
  'and nobody else''s');

select * from finish();
rollback;
