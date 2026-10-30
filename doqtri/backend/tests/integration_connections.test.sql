-- pgTAP tests for 20261025100000_integration_connections.sql (WP-2.3).
--
-- Run against a database that has every migration applied and the pgtap
-- extension available, e.g. a Supabase branch or a local stack:
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/integration_connections.test.sql
--
-- Everything runs in one transaction that is rolled back. A user is "signed
-- in" by switching to the authenticated role with their id in the JWT claims.
--
-- Cast:
--   a   ana@example.com   connected to qdit
--   b   ben@example.com   needs to reconnect
--   x   outsider@example.com, no connection

begin;
create extension if not exists pgtap with schema extensions;

select plan(36);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'ana@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'ben@example.com'),
  ('00000000-0000-4000-8000-000000000003', 'outsider@example.com');

insert into public.integration_connections
  (user_id, provider, subject, account_label, scopes, access_token_ciphertext, refresh_token_ciphertext, expires_at)
values
  ('00000000-0000-4000-8000-000000000001', 'qdit', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', 'ana',
   '{openid}', 'v1.access-ciphertext-a', 'v1.refresh-ciphertext-a', now() + interval '1 hour');
insert into public.integration_connections (user_id, provider, subject, status)
values ('00000000-0000-4000-8000-000000000002', 'qdit', '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', 'needs_reconnect');


-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select has_table('public', 'integration_connections', 'integration_connections exists');
select col_is_pk('public', 'integration_connections', array['user_id', 'provider'], 'one row per user and provider');
select is(
  (select relrowsecurity from pg_class where oid = 'public.integration_connections'::regclass),
  true, 'RLS is on');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'integration_connections'),
  0, 'no policies: no client role reaches a row');

select ok(not has_table_privilege('authenticated', 'public.integration_connections', 'select'), 'authenticated cannot select');
select ok(not has_table_privilege('authenticated', 'public.integration_connections', 'insert'), 'authenticated cannot insert');
select ok(not has_table_privilege('authenticated', 'public.integration_connections', 'update'), 'authenticated cannot update');
select ok(not has_table_privilege('authenticated', 'public.integration_connections', 'delete'), 'authenticated cannot delete');
select ok(not has_column_privilege('authenticated', 'public.integration_connections', 'access_token_ciphertext', 'select'),
  'authenticated cannot read the access token column');
select ok(not has_column_privilege('authenticated', 'public.integration_connections', 'refresh_token_ciphertext', 'select'),
  'authenticated cannot read the refresh token column');
select ok(not has_table_privilege('anon', 'public.integration_connections', 'select'), 'anon cannot select');
select ok(not has_table_privilege('anon', 'public.integration_connections', 'insert'), 'anon cannot insert');
select ok(has_table_privilege('service_role', 'public.integration_connections', 'select'), 'service_role can select');
select ok(has_table_privilege('service_role', 'public.integration_connections', 'update'), 'service_role can update');

select is(
  (select prosecdef from pg_proc where oid = 'public.my_integration_connections()'::regprocedure),
  true, 'my_integration_connections is security definer');
select is(
  (select proconfig from pg_proc where oid = 'public.my_integration_connections()'::regprocedure),
  array['search_path=""'], 'my_integration_connections pins an empty search_path');
select ok(not has_function_privilege('anon', 'public.my_integration_connections()', 'execute'), 'anon cannot call it');
select ok(has_function_privilege('authenticated', 'public.my_integration_connections()', 'execute'), 'authenticated can call it');
select is(
  (select count(*)::int
     from pg_proc p, unnest(p.proargnames) as a(name)
    where p.oid = 'public.my_integration_connections()'::regprocedure and a.name like '%token%'),
  0, 'it returns no token column');


-- ---------------------------------------------------------------------------
-- Signed in: tokens unreachable, own status readable
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(
  $$ select access_token_ciphertext from public.integration_connections $$,
  '42501', null, 'the owner cannot read their own token');
select throws_ok(
  $$ select count(*) from public.integration_connections $$,
  '42501', null, 'the owner cannot even count the rows');
select throws_ok(
  $$ update public.integration_connections set status = 'connected' $$,
  '42501', null, 'the owner cannot change their row');
select throws_ok(
  $$ insert into public.integration_connections (user_id, provider, subject, status)
     values ('00000000-0000-4000-8000-000000000001', 'qdit', 'forged', 'revoked') $$,
  '42501', null, 'the owner cannot write a row');
select throws_ok(
  $$ delete from public.integration_connections $$,
  '42501', null, 'the owner cannot delete a row');

select is(
  (select array_agg(provider || ':' || subject || ':' || status || ':' || account_label)
     from public.my_integration_connections()),
  array['qdit:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d:connected:ana'],
  'my_integration_connections shows ana her own connection');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(
  (select array_agg(provider || ':' || status) from public.my_integration_connections()),
  array['qdit:needs_reconnect'], 'ben sees only his, needing a reconnect');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is((select count(*)::int from public.my_integration_connections()), 0, 'an outsider sees no connection');

reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok(
  $$ select * from public.my_integration_connections() $$,
  '42501', null, 'anon cannot call my_integration_connections');
reset role;


-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ insert into public.integration_connections (user_id, provider, subject)
     values ('00000000-0000-4000-8000-000000000003', 'github', 'x') $$,
  '23514', null, 'only provider qdit');
select throws_ok(
  $$ insert into public.integration_connections (user_id, provider, subject)
     values ('00000000-0000-4000-8000-000000000003', 'qdit', 'x') $$,
  '23514', null, 'a connected row needs an access token');
select throws_ok(
  $$ insert into public.integration_connections (user_id, provider, subject, status, refresh_token_ciphertext)
     values ('00000000-0000-4000-8000-000000000003', 'qdit', 'x', 'revoked', 'v1.r') $$,
  '23514', null, 'a revoked row keeps no token');
select throws_ok(
  $$ insert into public.integration_connections (user_id, provider, subject, status)
     values ('00000000-0000-4000-8000-000000000003', 'qdit', 'x', 'paused') $$,
  '23514', null, 'status is one of the three');
select throws_ok(
  $$ insert into public.integration_connections (user_id, provider, subject, status)
     values ('00000000-0000-4000-8000-000000000001', 'qdit', 'y', 'revoked') $$,
  '23505', null, 'a second qdit connection for the same user is refused');


-- ---------------------------------------------------------------------------
-- Writes as the service role, and account deletion
-- ---------------------------------------------------------------------------

set local role service_role;
update public.integration_connections
   set status = 'needs_reconnect', access_token_ciphertext = null, refresh_token_ciphertext = null,
       generation = generation + 1, updated_at = '2000-01-01'
 where user_id = '00000000-0000-4000-8000-000000000001' and provider = 'qdit' and generation = 1;
select is(
  (select generation from public.integration_connections where user_id = '00000000-0000-4000-8000-000000000001'),
  2::bigint, 'the service role writes under a generation check');
select ok(
  (select updated_at > '2000-01-01' from public.integration_connections
    where user_id = '00000000-0000-4000-8000-000000000001'),
  'updated_at is stamped on every update');
reset role;

delete from auth.users where id = '00000000-0000-4000-8000-000000000002';
select is(
  (select count(*)::int from public.integration_connections where user_id = '00000000-0000-4000-8000-000000000002'),
  0, 'deleting an account deletes its connections');

select * from finish();
rollback;
