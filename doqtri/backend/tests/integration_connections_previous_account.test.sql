-- pgTAP tests for 20261025140000_integration_connections_previous_account.sql
-- (WP-2.11, D-66).
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/integration_connections_previous_account.test.sql
--
-- Everything runs in one transaction that is rolled back. A user is "signed
-- in" by switching to the authenticated role with their id in the JWT claims.
--
-- Cast:
--   a   ana@example.com   reconnected from qdit account "ana-old" to "ana"
--   b   ben@example.com   connected, never switched

begin;
create extension if not exists pgtap with schema extensions;

select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'ana@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'ben@example.com');

insert into public.integration_connections
  (user_id, provider, subject, account_label, access_token_ciphertext, previous_subject, previous_account_label)
values
  ('00000000-0000-4000-8000-000000000001', 'qdit', 'qdit-ana-new', 'ana', 'v1.a', 'qdit-ana-old', 'ana-old'),
  ('00000000-0000-4000-8000-000000000002', 'qdit', 'qdit-ben', 'ben', 'v1.b', null, null);


-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

select has_column('public', 'integration_connections', 'previous_subject', 'previous_subject exists');
select has_column('public', 'integration_connections', 'previous_account_label', 'previous_account_label exists');
select is(
  (select relrowsecurity from pg_class where oid = 'public.integration_connections'::regclass),
  true, 'RLS is still on');
select ok(not has_column_privilege('authenticated', 'public.integration_connections', 'previous_subject', 'select'),
  'authenticated cannot read the new column directly');

select throws_ok(
  $$ update public.integration_connections set previous_account_label = repeat('x', 201)
      where user_id = '00000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'previous_account_label is at most 200 characters');
select lives_ok(
  $$ update public.integration_connections set previous_account_label = repeat('é', 200)
      where user_id = '00000000-0000-4000-8000-000000000002' $$,
  '200 characters fit, counted as characters, not bytes');
select throws_ok(
  $$ update public.integration_connections set previous_subject = ''
      where user_id = '00000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'previous_subject is not empty');


-- ---------------------------------------------------------------------------
-- my_integration_connections(), remade with the new columns
-- ---------------------------------------------------------------------------

select is(
  (select prosecdef from pg_proc where oid = 'public.my_integration_connections()'::regprocedure),
  true, 'still security definer');
select is(
  (select proconfig from pg_proc where oid = 'public.my_integration_connections()'::regprocedure),
  array['search_path=""'], 'still pins an empty search_path');
select ok(not has_function_privilege('anon', 'public.my_integration_connections()', 'execute'), 'anon still cannot call it');
select ok(has_function_privilege('authenticated', 'public.my_integration_connections()', 'execute'), 'authenticated still can');
select is(
  (select count(*)::int
     from pg_proc p, unnest(p.proargnames) as a(name)
    where p.oid = 'public.my_integration_connections()'::regprocedure and a.name like '%token%'),
  0, 'it still returns no token column');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  (select array_agg(subject || ':' || account_label || ' was ' || previous_subject || ':' || previous_account_label)
     from public.my_integration_connections()),
  array['qdit-ana-new:ana was qdit-ana-old:ana-old'],
  'ana sees which account her reconnect replaced');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(
  (select array_agg(coalesce(previous_subject, 'none')) from public.my_integration_connections()),
  array['none'], 'ben, who never switched, has no previous account');
select is(
  (select count(*)::int from public.my_integration_connections() where previous_subject = 'qdit-ana-old'),
  0, 'ben never sees ana''s previous account');

reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok(
  $$ select * from public.my_integration_connections() $$,
  '42501', null, 'anon cannot call it');
reset role;

select * from finish();
rollback;
