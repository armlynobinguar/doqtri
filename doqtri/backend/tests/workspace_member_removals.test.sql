-- pgTAP tests for 20261024160000_workspace_member_removals.sql (WP-1.8).
--
-- Run against a database that has every migration applied and the pgtap
-- extension available, e.g. a Supabase branch or a local stack:
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/workspace_member_removals.test.sql
--
-- Everything runs in one transaction that is rolled back. Users are created
-- by inserting into auth.users, which also gives each a personal workspace
-- (WP-1.1). A user is "signed in" by switching to the authenticated role with
-- their id in the JWT claims, which is what auth.uid() reads. now() is fixed
-- for the transaction, so removal and restore times are compared by presence,
-- not by order.
--
-- Cast:
--   o  owner@example.com     owner of the team workspace "acme"
--   ad admin@example.com     admin of acme, signs with a passkey wallet
--   ed editor@example.com    editor of acme, signs with Freighter
--   vw viewer@example.com    viewer of acme
--   g  a wallet account      editor of acme and of o's personal workspace

begin;
create extension if not exists pgtap with schema extensions;

select plan(32);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'owner@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'admin@example.com'),
  ('00000000-0000-4000-8000-000000000003', 'editor@example.com'),
  ('00000000-0000-4000-8000-000000000004', 'viewer@example.com'),
  ('00000000-0000-4000-8000-000000000005', 'g' || repeat('b', 55) || '@stellar.doqtri.local');

insert into public.wallet_accounts (address, user_id) values
  ('G' || repeat('E', 55), '00000000-0000-4000-8000-000000000003'),
  ('G' || repeat('B', 55), '00000000-0000-4000-8000-000000000005');
insert into public.smart_wallets (user_id, network, address, created_tx) values
  ('00000000-0000-4000-8000-000000000002', 'testnet', 'C' || repeat('A', 55), repeat('0', 64)),
  ('00000000-0000-4000-8000-000000000002', 'mainnet', 'C' || repeat('M', 55), repeat('1', 64));

create schema wp18_test;
grant usage on schema wp18_test to authenticated, anon;
create table wp18_test.ids (name text primary key, id uuid);
grant select, insert on wp18_test.ids to authenticated;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into wp18_test.ids select 'acme', (public.create_workspace('Acme', 'acme-wp18')).id;
reset role;
-- A second team workspace with no documents, so it can be deleted.
with w as (
  insert into public.workspaces (name, slug, created_by)
  values ('Empty', 'empty-wp18', '00000000-0000-4000-8000-000000000001') returning id
) insert into wp18_test.ids select 'empty', id from w;
insert into wp18_test.ids select 'o-personal', w.id from public.workspaces w
 where w.is_personal and w.created_by = '00000000-0000-4000-8000-000000000001';

insert into public.workspace_members (workspace_id, user_id, role)
select (select id from wp18_test.ids where name = 'acme'), u, r::public.workspace_role
  from (values
    ('00000000-0000-4000-8000-000000000002'::uuid, 'admin'),
    ('00000000-0000-4000-8000-000000000003'::uuid, 'editor'),
    ('00000000-0000-4000-8000-000000000004'::uuid, 'viewer'),
    ('00000000-0000-4000-8000-000000000005'::uuid, 'editor')) v(u, r);
insert into public.workspace_members (workspace_id, user_id, role) values
  ((select id from wp18_test.ids where name = 'o-personal'), '00000000-0000-4000-8000-000000000005', 'editor'),
  ((select id from wp18_test.ids where name = 'empty'), '00000000-0000-4000-8000-000000000003', 'editor');

insert into public.documents (id, user_id, workspace_id, title, markdown) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   (select id from wp18_test.ids where name = 'acme'), 'Team plan', '# Team plan'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
   (select id from wp18_test.ids where name = 'o-personal'), 'Mine', '# Mine');

create function wp18_test.rows(p_workspace text, p_user uuid)
returns table (role text, reason text, wallets text[], restored boolean)
language sql stable as $$
  select r.role::text, r.reason, r.wallet_addresses, r.restored_at is not null
    from public.workspace_member_removals r
   where r.workspace_id = (select id from wp18_test.ids where name = p_workspace)
     and r.user_id = p_user
   order by r.id
$$;


-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.workspace_member_removals'::regclass),
  'RLS is enabled on workspace_member_removals');
select is((select count(*)::int from pg_policies where tablename = 'workspace_member_removals'), 0,
  'and it has no policies: service role only');
select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('member_wallet_addresses', 'log_workspace_member_removal',
                        'handle_deleted_user_member_removals', 'signer_removals_for_document')),
  'every new security definer function pins search_path to empty');
select ok(not has_function_privilege('authenticated', 'public.signer_removals_for_document(uuid)', 'execute'),
  'authenticated cannot call signer_removals_for_document');
select ok(not has_function_privilege('anon', 'public.signer_removals_for_document(uuid)', 'execute'),
  'anon cannot call signer_removals_for_document');
select ok(has_function_privilege('service_role', 'public.signer_removals_for_document(uuid)', 'execute'),
  'the service role can, for the audit page');
select ok(not has_function_privilege('authenticated', 'public.member_wallet_addresses(uuid)', 'execute'),
  'authenticated cannot list another account''s wallets');
select ok(not has_table_privilege('authenticated', 'public.workspace_member_removals', 'insert'),
  'authenticated cannot write removals directly');


-- ---------------------------------------------------------------------------
-- Removal and demotion, by the app's own writers under RLS
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

select throws_ok(
  $$ select * from public.workspace_member_removals $$,
  '42501', null, 'a workspace owner cannot read the removal log');

delete from public.workspace_members
 where workspace_id = (select id from wp18_test.ids where name = 'acme')
   and user_id = '00000000-0000-4000-8000-000000000003';
delete from public.workspace_members
 where workspace_id = (select id from wp18_test.ids where name = 'acme')
   and user_id = '00000000-0000-4000-8000-000000000004';
update public.workspace_members set role = 'editor'
 where workspace_id = (select id from wp18_test.ids where name = 'acme')
   and user_id = '00000000-0000-4000-8000-000000000002';
reset role;

select results_eq(
  $$ select * from wp18_test.rows('acme', '00000000-0000-4000-8000-000000000003') $$,
  $$ values ('editor', 'removed', array['G' || repeat('E', 55)], false) $$,
  'removing an editor logs it with their Freighter address');
select is((select count(*)::int from wp18_test.rows('acme', '00000000-0000-4000-8000-000000000004')), 0,
  'removing a viewer logs nothing: they never signed');
select is((select count(*)::int from wp18_test.rows('acme', '00000000-0000-4000-8000-000000000002')), 0,
  'demoting an admin to editor logs nothing: they still sign');
select is((select count(*)::int from wp18_test.rows('empty', '00000000-0000-4000-8000-000000000003')), 0,
  'a removal is logged against its own workspace only');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
update public.workspace_members set role = 'viewer'
 where workspace_id = (select id from wp18_test.ids where name = 'acme')
   and user_id = '00000000-0000-4000-8000-000000000002';
reset role;

select results_eq(
  $$ select * from wp18_test.rows('acme', '00000000-0000-4000-8000-000000000002') $$,
  $$ values ('editor', 'demoted', array['C' || repeat('A', 55), 'C' || repeat('M', 55)], false) $$,
  'demoting to viewer logs it, with the passkey wallet of every network');

-- A member leaving logs like a removal.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
delete from public.workspace_members
 where workspace_id = (select id from wp18_test.ids where name = 'empty')
   and user_id = '00000000-0000-4000-8000-000000000003';
reset role;
select results_eq(
  $$ select role, reason from wp18_test.rows('empty', '00000000-0000-4000-8000-000000000003') $$,
  $$ values ('editor', 'removed') $$,
  'an editor leaving is logged as a removal');


-- ---------------------------------------------------------------------------
-- Restoring
-- ---------------------------------------------------------------------------

-- Membership is invite-only (WP-1.5): the owner invites, the editor accepts.
-- By wallet address, since email invites ship switched off (D-49).
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
insert into wp18_test.ids select 'ed-invite',
  public.invite_workspace_member((select id from wp18_test.ids where name = 'acme'), 'G' || repeat('E', 55), 'viewer');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select public.accept_workspace_invite((select id from wp18_test.ids where name = 'ed-invite'));
reset role;
select is((select restored from wp18_test.rows('acme', '00000000-0000-4000-8000-000000000003')), false,
  'adding them back as a viewer does not restore signing');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
update public.workspace_members set role = 'editor'
 where workspace_id = (select id from wp18_test.ids where name = 'acme')
   and user_id = '00000000-0000-4000-8000-000000000003';
update public.workspace_members set role = 'admin'
 where workspace_id = (select id from wp18_test.ids where name = 'acme')
   and user_id = '00000000-0000-4000-8000-000000000002';
reset role;
select is((select restored from wp18_test.rows('acme', '00000000-0000-4000-8000-000000000003')), true,
  'promoting them back to editor closes the removal');
select is((select restored from wp18_test.rows('acme', '00000000-0000-4000-8000-000000000002')), true,
  'promoting a demoted viewer back to admin closes theirs');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
delete from public.workspace_members
 where workspace_id = (select id from wp18_test.ids where name = 'acme')
   and user_id = '00000000-0000-4000-8000-000000000003';
reset role;
select results_eq(
  $$ select reason, restored from wp18_test.rows('acme', '00000000-0000-4000-8000-000000000003') $$,
  $$ values ('removed', true), ('removed', false) $$,
  'a second removal is a new open row; the closed one stays closed');

insert into public.workspace_members (workspace_id, user_id, role)
values ((select id from wp18_test.ids where name = 'acme'), '00000000-0000-4000-8000-000000000003', 'editor');
select is((select count(*)::int from wp18_test.rows('acme', '00000000-0000-4000-8000-000000000003') where not restored), 0,
  'adding them straight back as an editor closes every open row');

update public.workspace_member_removals set restored_at = null
 where user_id = '00000000-0000-4000-8000-000000000003';


-- ---------------------------------------------------------------------------
-- Account deletion
-- ---------------------------------------------------------------------------

delete from auth.users where id = '00000000-0000-4000-8000-000000000005';

select results_eq(
  $$ select * from wp18_test.rows('acme', '00000000-0000-4000-8000-000000000005') $$,
  $$ values ('editor', 'removed', array['G' || repeat('B', 55)], false) $$,
  'deleting an account logs its membership once, with the Freighter address it had');
select results_eq(
  $$ select role, reason from wp18_test.rows('o-personal', '00000000-0000-4000-8000-000000000005') $$,
  $$ values ('editor', 'removed') $$,
  'including a membership in someone else''s personal workspace (D-30)');
select is((select count(*)::int from public.wallet_accounts where user_id = '00000000-0000-4000-8000-000000000005'), 0,
  'the wallet mapping itself is gone with the account');

-- The deleted account's own personal workspace is not logged.
insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000006', 'solo@example.com');
insert into wp18_test.ids select 's-personal', w.id from public.workspaces w
 where w.is_personal and w.created_by = '00000000-0000-4000-8000-000000000006';
delete from auth.users where id = '00000000-0000-4000-8000-000000000006';
select is((select count(*)::int from public.workspace_member_removals
            where user_id = '00000000-0000-4000-8000-000000000006'), 0,
  'deleting an account logs nothing for its own personal workspace');

-- A refused deletion leaves no rows behind. The owner of acme is its last
-- owner with an admin, so it would pass; make it fail by removing the admin.
update public.workspace_members set role = 'editor'
 where workspace_id = (select id from wp18_test.ids where name = 'acme')
   and user_id = '00000000-0000-4000-8000-000000000002';
select throws_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-000000000001' $$,
  '23001', null, 'deleting acme''s last owner with no admin is refused (D-31)');
select is((select count(*)::int from public.workspace_member_removals
            where user_id = '00000000-0000-4000-8000-000000000001'), 0,
  'and the refused deletion logs nothing');


-- ---------------------------------------------------------------------------
-- Deleting a workspace
-- ---------------------------------------------------------------------------

select lives_ok(
  $$ delete from public.workspaces where id = (select id from wp18_test.ids where name = 'empty') $$,
  'a workspace with a removal log can still be deleted');
select is((select count(*)::int from public.workspace_member_removals
            where workspace_id = (select id from wp18_test.ids where name = 'empty')), 0,
  'its removal rows go with it, and its cascaded memberships log nothing');


-- ---------------------------------------------------------------------------
-- signer_removals_for_document
-- ---------------------------------------------------------------------------

select results_eq(
  $$ select address, restored_at is not null
       from public.signer_removals_for_document('10000000-0000-4000-8000-000000000001')
      order by address $$,
  $$ values ('C' || repeat('A', 55), true), ('C' || repeat('M', 55), true),
            ('G' || repeat('B', 55), false),
            ('G' || repeat('E', 55), false), ('G' || repeat('E', 55), false) $$,
  'a team note gets one row per removal and wallet address of its workspace');
select results_eq(
  $$ select address from public.signer_removals_for_document('10000000-0000-4000-8000-000000000002') $$,
  $$ values ('G' || repeat('B', 55)) $$,
  'a note in a personal workspace gets that workspace''s removals only');
select is((select count(*)::int from public.signer_removals_for_document('10000000-0000-4000-8000-0000000000ff')), 0,
  'an unknown note gets none');

set local role service_role;
select is((select count(*)::int from public.signer_removals_for_document('10000000-0000-4000-8000-000000000001')), 5,
  'the service role reads it');
reset role;

select * from finish();
rollback;
