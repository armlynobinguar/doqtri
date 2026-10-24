-- pgTAP tests for 20261024150500_workspace_members_management.sql (WP-1.5).
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/workspace_members_management.test.sql
--
-- One transaction, rolled back. Users are signed in by switching to the
-- authenticated role with their id in the JWT claims (auth.uid()).
--
-- Cast, in the team workspace "acme":
--   o  owner@example.com    owner, has a passkey wallet (C...)
--   ad admin@example.com    admin, has a passkey wallet
--   ed editor@example.com   editor, has a passkey wallet
--   vw viewer@example.com   viewer, no wallet
--   x  outsider@example.com in no workspace but their own, no wallet
--   w  a wallet account (G...), in no workspace yet
--   y  late@example.com     invited later
--   n  newcomer@example.com signs up after being invited, confirms the
--                           email later, then holds a passkey wallet
--   h  held@example.com     an account that never confirms its email
--   g  guest@example.com    an editor of x's personal workspace
--   k  anchored@example.com holds a passkey wallet and anchored a personal note
--
-- Email invites start off, as they ship (D-49); the tests switch them on
-- once they have checked that.

begin;
create extension if not exists pgtap with schema extensions;

select plan(165);

-- Confirmed emails, except where a test says otherwise (D-49).
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner@example.com', now()),
  ('00000000-0000-4000-8000-0000000000a2', 'admin@example.com', now()),
  ('00000000-0000-4000-8000-0000000000a3', 'editor@example.com', now()),
  ('00000000-0000-4000-8000-0000000000a4', 'viewer@example.com', now()),
  ('00000000-0000-4000-8000-0000000000a5', 'outsider@example.com', now()),
  ('00000000-0000-4000-8000-0000000000a6', lower('G' || repeat('W', 55)) || '@stellar.doqtri.local', now()),
  ('00000000-0000-4000-8000-0000000000a7', 'Late@Example.com', now());

insert into public.smart_wallets (user_id, network, address, created_tx) values
  ('00000000-0000-4000-8000-0000000000a1', 'testnet', 'C' || repeat('O', 55), repeat('a', 64)),
  ('00000000-0000-4000-8000-0000000000a2', 'testnet', 'C' || repeat('D', 55), repeat('b', 64)),
  ('00000000-0000-4000-8000-0000000000a3', 'testnet', 'C' || repeat('E', 55), repeat('c', 64));
insert into public.wallet_accounts (address, user_id) values
  ('G' || repeat('W', 55), '00000000-0000-4000-8000-0000000000a6');

insert into public.workspaces (id, name, slug, created_by) values
  ('11000000-0000-4000-8000-000000000001', 'Acme', 'acme-wp15', '00000000-0000-4000-8000-0000000000a1');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('11000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a2', 'admin'),
  ('11000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a3', 'editor'),
  ('11000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a4', 'viewer');

create temp table ids as
  select (select id from public.workspaces where is_personal and created_by = '00000000-0000-4000-8000-0000000000a1') as o_personal;
grant select on ids to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select ok((select bool_and(relrowsecurity) from pg_class
            where oid in ('public.workspace_invites'::regclass, 'public.workspace_transfers'::regclass,
                          'public.workspace_chain_jobs'::regclass, 'public.invite_settings'::regclass)),
  'RLS is enabled on invites, transfers, chain jobs and the invite settings');
select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('enqueue_chain_revocation', 'workspace_members_chain_sync', 'find_account',
                        'account_label', 'account_chain_address', 'workspace_roster',
                        'workspace_pending_invites', 'my_workspace_invites', 'invite_workspace_member',
                        'accept_workspace_invite', 'cancel_workspace_invite', 'set_workspace_member_role',
                        'remove_workspace_member', 'propose_workspace_transfer', 'cancel_workspace_transfer',
                        'accept_workspace_transfer', 'claim_workspace_chain_jobs',
                        'invite_identifier', 'my_invite_identifiers', 'email_invites_enabled',
                        'handle_deleted_user_workspaces')),
  'every new security definer function pins search_path to empty');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('enqueue_chain_revocation', 'workspace_members_chain_sync', 'find_account',
                        'account_label', 'account_chain_address', 'workspace_roster',
                        'workspace_pending_invites', 'my_workspace_invites', 'invite_workspace_member',
                        'accept_workspace_invite', 'cancel_workspace_invite', 'set_workspace_member_role',
                        'remove_workspace_member', 'propose_workspace_transfer', 'cancel_workspace_transfer',
                        'accept_workspace_transfer', 'claim_workspace_chain_jobs',
                        'invite_identifier', 'my_invite_identifiers', 'email_invites_enabled')),
  20, 'and they all exist');

select ok(not has_function_privilege('anon',
  'public.invite_workspace_member(uuid, text, public.workspace_role)', 'execute'),
  'anon cannot invite');
select ok(has_function_privilege('authenticated',
  'public.invite_workspace_member(uuid, text, public.workspace_role)', 'execute'),
  'authenticated can call invite_workspace_member');
select ok(not has_function_privilege('authenticated',
  'public.accept_workspace_transfer(uuid, uuid)', 'execute'),
  'authenticated cannot accept a transfer directly: the route does, after the chain (D-04)');
select ok(has_function_privilege('service_role',
  'public.accept_workspace_transfer(uuid, uuid)', 'execute'),
  'the service role can');
select ok(not has_function_privilege('authenticated',
  'public.claim_workspace_chain_jobs(uuid, integer)', 'execute'),
  'authenticated cannot claim chain jobs');
select ok(not has_function_privilege('authenticated', 'public.find_account(text)', 'execute'),
  'authenticated cannot look accounts up directly');
select ok(not has_function_privilege('authenticated', 'public.account_label(uuid)', 'execute'),
  'nor read an account''s label directly');
select ok(not has_function_privilege('authenticated', 'public.enqueue_chain_revocation(uuid, uuid)', 'execute'),
  'authenticated cannot queue chain jobs directly');
select ok(not has_function_privilege('authenticated', 'public.account_chain_address(uuid, text)', 'execute'),
  'authenticated cannot read wallets directly');
select ok(has_function_privilege('authenticated', 'public.email_invites_enabled()', 'execute'),
  'authenticated can ask whether email invites are on');
select ok(not has_table_privilege('authenticated', 'public.invite_settings', 'select')
          and not has_table_privilege('authenticated', 'public.invite_settings', 'update'),
  'but neither reads nor switches the setting');


-- ---------------------------------------------------------------------------
-- No direct membership inserts
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select throws_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     values ('11000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a5', 'viewer') $$,
  '42501', null, 'not even the owner inserts a member: invites only');
select throws_ok(
  $$ insert into public.workspace_invites (workspace_id, invitee, role)
     values ('11000000-0000-4000-8000-000000000001', 'outsider@example.com', 'viewer') $$,
  '42501', null, 'nor an invite, except through invite_workspace_member');


-- ---------------------------------------------------------------------------
-- Roster
-- ---------------------------------------------------------------------------

select results_eq(
  $$ select label, role::text, address from public.workspace_roster('11000000-0000-4000-8000-000000000001', 'testnet') $$,
  $$ values ('owner@example.com'::text, 'owner'::text, ('C' || repeat('O', 55))::text),
            ('admin@example.com', 'admin', 'C' || repeat('D', 55)),
            ('editor@example.com', 'editor', 'C' || repeat('E', 55)),
            ('viewer@example.com', 'viewer', null) $$,
  'the roster lists every member by rank, with label and signing wallet');
select is(
  (select count(*)::int from public.workspace_roster('11000000-0000-4000-8000-000000000001', 'mainnet') where address is not null),
  0, 'wallets are per network');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}';
select is(
  (select count(*)::int from public.workspace_roster('11000000-0000-4000-8000-000000000001', 'testnet')),
  4, 'a viewer reads the roster too');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}';
select is(
  (select count(*)::int from public.workspace_roster('11000000-0000-4000-8000-000000000001', 'testnet')),
  0, 'an outsider reads nothing');


-- ---------------------------------------------------------------------------
-- Inviting
-- ---------------------------------------------------------------------------

-- outsider, viewer, editor
select throws_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'late@example.com', 'viewer') $$,
  '42501', null, 'an outsider cannot invite');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}';
select throws_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'late@example.com', 'viewer') $$,
  '42501', null, 'a viewer cannot invite');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select throws_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'late@example.com', 'viewer') $$,
  '42501', null, 'an editor cannot invite');

-- admin, with email invites off as they ship (D-49)
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select is(public.email_invites_enabled(), false, 'email invites ship switched off');
select throws_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'late@example.com', 'viewer') $$,
  '22023', 'Invites by email are off for now. Invite them by their wallet address.',
  'so an admin cannot invite by email: with confirmations off, whoever registered it would take the invite');
select throws_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'editor@example.com', 'viewer') $$,
  '22023', null, 'not even an email that already has an account, which would say so');
select is((select count(*)::int from public.workspace_invites), 0, 'nothing was invited');

-- An operator switches them on once "Confirm email" is on.
reset role;
update public.invite_settings set email_invites = true;
set local role authenticated;
select is(public.email_invites_enabled(), true, 'the operator switches email invites on');
select throws_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'late@example.com', 'owner') $$,
  '22023', null, 'nobody is invited as owner');
select throws_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'not an address', 'viewer') $$,
  '22023', null, 'a malformed identifier is refused');
select lives_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'nobody@example.com', 'viewer') $$,
  'an email no account uses is invited all the same: the answer does not say whether one exists');
select throws_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001',
       lower('G' || repeat('W', 55)) || '@stellar.doqtri.local', 'viewer') $$,
  '22023', null, 'a wallet account''s synthetic email is not an address anyone types');
select lives_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'G' || repeat('Z', 55), 'viewer') $$,
  'and so is a wallet nobody uses');
select throws_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'editor@example.com', 'viewer') $$,
  '23505', null, 'a member is not invited again');
select throws_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'C' || repeat('E', 55), 'viewer') $$,
  '23505', null, 'nor by their passkey wallet');

select lives_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', '  LATE@example.com ', 'viewer') $$,
  'an admin invites by email, case- and space-insensitively');
select lives_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'late@example.com', 'editor') $$,
  'inviting again replaces the open invite');
select results_eq(
  $$ select role::text from public.workspace_invites
      where workspace_id = '11000000-0000-4000-8000-000000000001' and invitee = 'late@example.com' $$,
  $$ values ('editor'::text) $$,
  'one invite per address, with the latest role');
select lives_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'G' || repeat('W', 55), 'admin') $$,
  'an admin invites a wallet account by its address, as admin');
select lives_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'outsider@example.com', 'viewer') $$,
  'and the outsider, as viewer');
select results_eq(
  $$ select label, role::text from public.workspace_pending_invites('11000000-0000-4000-8000-000000000001') order by label $$,
  $$ values ('G' || repeat('W', 55), 'admin'::text), ('G' || repeat('Z', 55), 'viewer'),
            ('late@example.com', 'editor'), ('nobody@example.com', 'viewer'), ('outsider@example.com', 'viewer') $$,
  'admins list the open invites by what was typed, with or without an account behind it');
select lives_ok(
  $$ select public.cancel_workspace_invite(i.id) from public.workspace_invites i
      where i.invitee in ('nobody@example.com', 'G' || repeat('Z', 55)) $$,
  'the admin withdraws the two nobody can accept yet');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select is((select count(*)::int from public.workspace_pending_invites('11000000-0000-4000-8000-000000000001')),
  0, 'editors do not see open invites');
select is((select count(*)::int from public.workspace_invites), 0, 'nor read the table');


-- ---------------------------------------------------------------------------
-- Accepting, declining, withdrawing
-- ---------------------------------------------------------------------------

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a7","role":"authenticated"}';
select results_eq(
  $$ select workspace_name, role::text, invited_by from public.my_workspace_invites() $$,
  $$ values ('Acme'::text, 'editor'::text, 'admin@example.com'::text) $$,
  'the invitee sees their invite, the workspace''s name and who sent it');
select is((select count(*)::int from public.workspaces where id = '11000000-0000-4000-8000-000000000001'),
  0, 'but cannot read the workspace before accepting');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}';
select throws_ok(
  format($$ select public.accept_workspace_invite(%L) $$,
    (select id from public.workspace_invites where invitee = 'late@example.com')),
  'P0002', null, 'nobody accepts someone else''s invite');
select is((select count(*)::int from public.workspace_invites), 1,
  'the outsider reads only their own invite');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a7","role":"authenticated"}';
select is(
  public.accept_workspace_invite((select id from public.workspace_invites)),
  '11000000-0000-4000-8000-000000000001'::uuid, 'the invitee accepts and gets the workspace id');
select is((select role::text from public.workspace_members
            where workspace_id = '11000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-0000000000a7'),
  'editor', 'and is a member with the invite''s role');
select is((select count(*)::int from public.workspace_invites), 0, 'the invite is gone');
select throws_ok(
  $$ select public.accept_workspace_invite(gen_random_uuid()) $$,
  'P0002', null, 'a missing invite cannot be accepted');

-- The outsider declines.
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}';
select lives_ok(
  $$ select public.cancel_workspace_invite((select id from public.workspace_invites)) $$,
  'an invitee declines');
select is((select count(*)::int from public.workspace_members
            where workspace_id = '11000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-0000000000a5'),
  0, 'and does not join');

-- An editor cannot withdraw w's invite; the owner can.
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select throws_ok(
  $$ select public.cancel_workspace_invite(
       (select id from public.workspace_pending_invites('11000000-0000-4000-8000-000000000001') limit 1)) $$,
  'P0002', null, 'an editor cannot withdraw an invite');
reset role;
create temp table w_invite as
  select id from public.workspace_invites where invitee = 'G' || repeat('W', 55);
grant select on w_invite to authenticated;
set local role authenticated;
select throws_ok(
  $$ select public.cancel_workspace_invite((select id from w_invite)) $$,
  'P0002', null, 'not even when it knows the invite''s id');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select lives_ok(
  $$ select public.cancel_workspace_invite((select id from w_invite)) $$,
  'the owner withdraws an invite');
select is((select count(*)::int from public.workspace_invites
            where workspace_id = '11000000-0000-4000-8000-000000000001'),
  0, 'no invites are left open');


-- ---------------------------------------------------------------------------
-- Changing roles
-- ---------------------------------------------------------------------------

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select throws_ok(
  $$ select public.set_workspace_member_role('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a4', 'editor') $$,
  '42501', null, 'an editor cannot change roles');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select throws_ok(
  $$ select public.set_workspace_member_role('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a4', 'owner') $$,
  '22023', null, 'nobody is made owner by a role change');
select throws_ok(
  $$ select public.set_workspace_member_role('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a1', 'viewer') $$,
  '42501', null, 'an admin cannot demote the owner');
select throws_ok(
  $$ select public.set_workspace_member_role('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a5', 'viewer') $$,
  'P0002', null, 'a non-member has no role to change');
select throws_ok(
  $$ update public.workspace_members set role = 'owner'
      where workspace_id = '11000000-0000-4000-8000-000000000001'
        and user_id = '00000000-0000-4000-8000-0000000000a3' $$,
  '42501', null, 'nor directly');
select lives_ok(
  $$ select public.set_workspace_member_role('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a4', 'editor') $$,
  'an admin promotes a viewer to editor');
select is((select count(*)::int from public.workspace_chain_jobs), 0,
  'a promotion queues nothing: an admin signs add_editor from the members screen');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select lives_ok(
  $$ select public.set_workspace_member_role('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a2', 'editor') $$,
  'the owner demotes the admin to editor');
reset role;
select results_eq(
  $$ select kind, user_id, address, network, status from public.workspace_chain_jobs $$,
  $$ values ('revoke'::text, '00000000-0000-4000-8000-0000000000a2'::uuid, ('C' || repeat('D', 55))::text,
             'testnet'::text, 'pending'::text) $$,
  'demoting an admin queues the revocation of their admin role on-chain');
set local role authenticated;
select lives_ok(
  $$ select public.set_workspace_member_role('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a2', 'admin') $$,
  'and promotes them back');
select lives_ok(
  $$ select public.set_workspace_member_role('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a2', 'viewer') $$,
  'and demotes them again');
reset role;
select is((select count(*)::int from public.workspace_chain_jobs where status = 'pending'), 1,
  'an open job for the same wallet covers a second demotion');
set local role authenticated;
select lives_ok(
  $$ select public.set_workspace_member_role('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a2', 'admin') $$,
  'the admin is restored');

-- An admin's open invites go when they stop being an admin.
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select lives_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'outsider@example.com', 'admin') $$,
  'the admin invites the outsider as admin');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select lives_ok(
  $$ select public.invite_workspace_member('11000000-0000-4000-8000-000000000001', 'G' || repeat('W', 55), 'viewer') $$,
  'and the owner invites w');
select lives_ok(
  $$ select public.set_workspace_member_role('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a2', 'editor') $$,
  'the owner demotes the admin');
select results_eq(
  $$ select invitee from public.workspace_invites where workspace_id = '11000000-0000-4000-8000-000000000001' $$,
  $$ values ('G' || repeat('W', 55)) $$,
  'the invites the demoted admin sent are withdrawn; the owner''s stay');
select lives_ok(
  $$ select public.cancel_workspace_invite((select id from public.workspace_invites
       where workspace_id = '11000000-0000-4000-8000-000000000001')) $$,
  'the owner withdraws theirs too');
select lives_ok(
  $$ select public.set_workspace_member_role('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a2', 'admin') $$,
  'and makes them admin again');


-- ---------------------------------------------------------------------------
-- Removing and leaving (D-16)
-- ---------------------------------------------------------------------------

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}';
select throws_ok(
  $$ select public.remove_workspace_member('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a3') $$,
  '42501', null, 'an editor cannot remove another member');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select throws_ok(
  $$ select public.remove_workspace_member('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a1') $$,
  '42501', null, 'an admin cannot remove the owner');
select lives_ok(
  $$ select public.remove_workspace_member('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a3') $$,
  'an admin removes an editor');
select is((select count(*)::int from public.workspace_members
            where workspace_id = '11000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-0000000000a3'),
  0, 'at once, in the database');
select results_eq(
  $$ select user_id, address, status from public.workspace_chain_jobs
      where user_id = '00000000-0000-4000-8000-0000000000a3' $$,
  $$ values ('00000000-0000-4000-8000-0000000000a3'::uuid, ('C' || repeat('E', 55))::text, 'pending'::text) $$,
  'and their on-chain removal is queued in the same transaction');
select is((select count(*)::int from public.workspace_chain_jobs), 2,
  'admins see the workspace''s pending chain jobs');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select is((select count(*)::int from public.workspace_chain_jobs), 1,
  'the removed member sees their own pending removal');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}';
select is((select count(*)::int from public.workspace_chain_jobs) + (select count(*)::int from public.workspaces
            where id = '11000000-0000-4000-8000-000000000001'),
  0, 'an outsider sees neither the workspace nor its jobs, so chain-sync refuses them');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select throws_ok(
  $$ update public.workspace_chain_jobs set status = 'done' $$,
  '42501', null, 'but no client changes a job');
select throws_ok(
  $$ insert into public.workspace_chain_jobs (workspace_id, kind, address)
     values ('11000000-0000-4000-8000-000000000001', 'revoke', 'C' || repeat('E', 55)) $$,
  '42501', null, 'or queues one');

-- y (editor, no wallet) leaves.
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a7","role":"authenticated"}';
select lives_ok(
  $$ select public.remove_workspace_member('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a7') $$,
  'a member leaves');
reset role;
select is((select count(*)::int from public.workspace_chain_jobs
            where user_id = '00000000-0000-4000-8000-0000000000a7'),
  0, 'someone with no wallet never held an on-chain role and queues nothing');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select throws_ok(
  $$ select public.remove_workspace_member('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a1') $$,
  '23514', 'a workspace must keep at least one owner', 'the owner cannot leave: they transfer first');
select throws_ok(
  $$ select public.remove_workspace_member('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a5') $$,
  'P0002', null, 'removing a non-member is reported');


-- ---------------------------------------------------------------------------
-- Ownership transfer (D-29, D-30, D-35, D-37)
-- ---------------------------------------------------------------------------

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select throws_ok(
  $$ select public.propose_workspace_transfer('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a2') $$,
  '42501', null, 'only the owner proposes a transfer');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
select throws_ok(
  $$ select public.propose_workspace_transfer((select o_personal from ids),
       '00000000-0000-4000-8000-0000000000a2') $$,
  '22023', null, 'a personal workspace is never transferred (D-30, D-37)');
select throws_ok(
  $$ select public.propose_workspace_transfer('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a1') $$,
  '22023', null, 'nor to its own owner');
select throws_ok(
  $$ select public.propose_workspace_transfer('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a5') $$,
  'P0002', null, 'nor to a non-member');
select throws_ok(
  $$ select public.propose_workspace_transfer('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a2', 'C' || repeat('O', 55), null, 'approval') $$,
  '23514', null, 'chain fields come all together or not at all');
select lives_ok(
  $$ select public.propose_workspace_transfer('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a4') $$,
  'the owner proposes handing acme to the viewer-turned-editor');
select lives_ok(
  $$ select public.propose_workspace_transfer('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a2', 'C' || repeat('O', 55), 'C' || repeat('D', 55), 'AAAA') $$,
  'and replaces it with one to the admin, with their signed approval');
select results_eq(
  $$ select to_user, owner_address, new_owner_address, owner_approval from public.workspace_transfers $$,
  $$ values ('00000000-0000-4000-8000-0000000000a2'::uuid, ('C' || repeat('O', 55))::text,
             ('C' || repeat('D', 55))::text, 'AAAA'::text) $$,
  'one open transfer per workspace');
select throws_ok(
  $$ update public.workspace_transfers set to_user = '00000000-0000-4000-8000-0000000000a4' $$,
  '42501', null, 'no client edits a transfer');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select is((select count(*)::int from public.workspace_transfers), 1, 'the new owner sees it');
select throws_ok(
  $$ select public.accept_workspace_transfer('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a2') $$,
  '42501', null, 'but cannot accept it from the browser');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}';
select is((select count(*)::int from public.workspace_transfers), 0, 'an editor does not see it');
select throws_ok(
  $$ select public.cancel_workspace_transfer('11000000-0000-4000-8000-000000000001') $$,
  'P0002', null, 'nor calls it off');

reset role;
set local role service_role;
select throws_ok(
  $$ select public.accept_workspace_transfer('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a4') $$,
  'P0002', null, 'the route cannot accept for anyone but the named new owner');
select is(
  public.accept_workspace_transfer('11000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-0000000000a2'),
  '00000000-0000-4000-8000-0000000000a1'::uuid, 'the route accepts for the new owner and gets the former owner');
reset role;
select results_eq(
  $$ select user_id, role::text from public.workspace_members
      where workspace_id = '11000000-0000-4000-8000-000000000001' order by user_id $$,
  $$ values ('00000000-0000-4000-8000-0000000000a1'::uuid, 'admin'::text),
            ('00000000-0000-4000-8000-0000000000a2'::uuid, 'owner'::text),
            ('00000000-0000-4000-8000-0000000000a4'::uuid, 'editor'::text) $$,
  'the new owner owns it and the former owner stays as an admin (D-35)');
select is((select count(*)::int from public.workspace_members
            where workspace_id = '11000000-0000-4000-8000-000000000001' and role = 'owner'),
  1, 'with exactly one owner');
select is((select count(*)::int from public.workspace_transfers), 0, 'the transfer is closed');
select is((select count(*)::int from public.workspace_chain_jobs
            where user_id = '00000000-0000-4000-8000-0000000000a1'),
  0, 'the former owner queues no revocation: the transfer itself moved their role on-chain');

-- A transfer to someone who leaves is void.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select lives_ok(
  $$ select public.propose_workspace_transfer('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a4') $$,
  'the new owner proposes passing it on');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}';
select lives_ok(
  $$ select public.cancel_workspace_transfer('11000000-0000-4000-8000-000000000001') $$,
  'and the proposed owner declines');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
select lives_ok(
  $$ select public.propose_workspace_transfer('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a4') $$,
  'proposed again');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}';
select lives_ok(
  $$ select public.remove_workspace_member('11000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000a4') $$,
  'the proposed owner leaves instead');
reset role;
select is((select count(*)::int from public.workspace_transfers), 0, 'and the transfer goes with them');


-- ---------------------------------------------------------------------------
-- The server's queue
-- ---------------------------------------------------------------------------

set local role service_role;
select is(
  (select count(*)::int from public.claim_workspace_chain_jobs('11000000-0000-4000-8000-000000000001', 10)),
  2, 'the server claims the due jobs of a workspace');
select is(
  (select count(*)::int from public.claim_workspace_chain_jobs(null, 10)),
  0, 'a claimed job is not handed out again while its lease runs');
select is((select min(attempts) from public.workspace_chain_jobs), 1, 'each claim counts an attempt');
reset role;


-- ---------------------------------------------------------------------------
-- Invites say nothing about who holds an address
-- ---------------------------------------------------------------------------

-- x, a stranger to everyone, makes a workspace (so is its admin) and
-- invites the editor's passkey wallet, whose address is public on-chain.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}';
select lives_ok(
  $$ select public.create_workspace('Probe', 'probe-wp15') $$,
  'anyone can create a team workspace, and so be its admin');
reset role;
create temp table probe as select id from public.workspaces where slug = 'probe-wp15';
grant select on probe to authenticated;
set local role authenticated;
select lives_ok(
  $$ select public.invite_workspace_member((select id from probe), 'C' || repeat('E', 55), 'viewer') $$,
  'the stranger invites a passkey wallet they saw on-chain');
select results_eq(
  $$ select label from public.workspace_pending_invites((select id from probe)) $$,
  $$ values ('C' || repeat('E', 55)) $$,
  'and reads back only the address they typed');
select is(
  (select count(*)::int from public.workspace_invites
    where workspace_id = (select id from probe) and invitee like '%@%'),
  0, 'not the email of the account behind it, from the table either');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
select results_eq(
  $$ select workspace_name, invited_by from public.my_workspace_invites() $$,
  $$ values ('Probe'::text, 'outsider@example.com'::text) $$,
  'the wallet''s holder finds the invite');
select lives_ok(
  $$ select public.accept_workspace_invite((select id from public.my_workspace_invites())) $$,
  'and accepts it');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}';
select is(
  (select label from public.workspace_roster((select id from probe), 'testnet') where role = 'viewer'),
  'editor@example.com', 'only once they have joined does the roster name them');

-- An invite waits for whoever signs in with its address.
select lives_ok(
  $$ select public.invite_workspace_member((select id from probe), 'Newcomer@Example.com', 'editor') $$,
  'an invite can go to an email no account uses yet');
reset role;
create temp table newcomer_invite as
  select id from public.workspace_invites where invitee = 'newcomer@example.com';
grant select on newcomer_invite to authenticated;
-- An account whose email is not confirmed has not shown it owns the inbox
-- (D-49). With "Confirm email" on, which email invites require, that is an
-- account still waiting on its mail, or one an admin made unconfirmed. (With
-- it off Supabase confirms at signup, so this check alone would not help:
-- that is what the invite_settings switch is for.)
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000a8', 'newcomer@example.com');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a8","role":"authenticated"}';
select is((select count(*)::int from public.my_workspace_invites()), 0,
  'an account that has not confirmed the invited email does not see the invite');
select is((select count(*)::int from public.workspace_invites), 0,
  'nor read it from the table');
select throws_ok(
  $$ select public.accept_workspace_invite((select id from newcomer_invite)) $$,
  'P0002', null, 'nor accept it by its id');
reset role;
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-8000-0000000000a8';
set local role authenticated;
select results_eq(
  $$ select workspace_name, role::text from public.my_workspace_invites() $$,
  $$ values ('Probe'::text, 'editor'::text) $$,
  'once the email is confirmed, its account finds the invite');

-- Switched off again, email invites are neither sent nor delivered.
reset role;
update public.invite_settings set email_invites = false;
set local role authenticated;
select is((select count(*)::int from public.my_workspace_invites()), 0,
  'with email invites switched off again, an open one is not delivered');
select throws_ok(
  $$ select public.accept_workspace_invite((select id from newcomer_invite)) $$,
  'P0002', null, 'nor accepted');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}';
select is((select count(*)::int from public.workspace_pending_invites((select id from probe))
            where label = 'newcomer@example.com'),
  1, 'it stays listed for the admin to withdraw');
reset role;
update public.invite_settings set email_invites = true;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a8","role":"authenticated"}';
select is((select count(*)::int from public.my_workspace_invites()), 1,
  'and is delivered again once they are back on');

-- Nobody floods strangers with invites.
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}';
select lives_ok(
  $$ select count(public.invite_workspace_member((select id from probe), 'spam' || g || '@example.com', 'viewer'))
       from generate_series(1, 99) g $$,
  'an admin has up to 100 invites sent in a day open at once');
select throws_ok(
  $$ select public.invite_workspace_member((select id from probe), 'one-more@example.com', 'viewer') $$,
  '54000', null, 'and no more');
select lives_ok(
  $$ select public.invite_workspace_member((select id from probe), 'spam1@example.com', 'editor') $$,
  'changing an open invite is not another one');
reset role;


-- ---------------------------------------------------------------------------
-- Deleting an account (D-31): handover and revocations
-- ---------------------------------------------------------------------------

-- beta: w (wallet account, G...) owns it; o, ad and ed are its admins, in
-- that order of succession (same joined_at, then user id). Deleting w hands
-- beta to o and queues admin_reassign_owner.
insert into public.workspaces (id, name, slug, created_by) values
  ('11000000-0000-4000-8000-000000000002', 'Beta', 'beta-wp15', '00000000-0000-4000-8000-0000000000a6');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('11000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a1', 'admin'),
  ('11000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a2', 'admin'),
  ('11000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a3', 'admin');
-- and w edits acme (as an accepted invite would leave it)
insert into public.workspace_members (workspace_id, user_id, role) values
  ('11000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a6', 'editor');

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000a6' $$,
  'the last owner of a team workspace with an admin deletes their account');
select is((select role::text from public.workspace_members
            where workspace_id = '11000000-0000-4000-8000-000000000002'
              and user_id = '00000000-0000-4000-8000-0000000000a1'),
  'owner', 'the longest-standing admin takes over (D-31)');
select results_eq(
  $$ select kind, user_id, status from public.workspace_chain_jobs
      where workspace_id = '11000000-0000-4000-8000-000000000002' $$,
  $$ values ('reassign_owner'::text, '00000000-0000-4000-8000-0000000000a1'::uuid, 'pending'::text) $$,
  'and admin_reassign_owner to them is queued for the contract admin (D-36)');
select results_eq(
  $$ select kind, address, network from public.workspace_chain_jobs
      where workspace_id = '11000000-0000-4000-8000-000000000001' and address like 'G%' $$,
  $$ values ('revoke'::text, ('G' || repeat('W', 55))::text, null::text) $$,
  'the deleted account''s editor role elsewhere is queued for revocation, by its Stellar account');

-- The heir deletes their account before the chain caught up: the handover
-- is still pending, as it stays while REGISTRY_EDITORS is off. Both heirs
-- hold passkey wallets, which are retired with their accounts (D-51).
select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000a1' $$,
  'the heir deletes their own account while the handover to them is still pending');
select is((select role::text from public.workspace_members
            where workspace_id = '11000000-0000-4000-8000-000000000002' and user_id = '00000000-0000-4000-8000-0000000000a2'),
  'owner', 'the next admin takes beta over');
select results_eq(
  $$ select user_id, status, attempts from public.workspace_chain_jobs
      where workspace_id = '11000000-0000-4000-8000-000000000002' and kind = 'reassign_owner' $$,
  $$ values ('00000000-0000-4000-8000-0000000000a2'::uuid, 'pending'::text, 0) $$,
  'and the open handover now names them, not the deleted heir');

-- This time the handover waits for the product owner when its heir goes.
-- ad also owns acme, which needs an admin to pass to: x.
update public.workspace_chain_jobs set status = 'needs_product_owner', attempts = 3
 where workspace_id = '11000000-0000-4000-8000-000000000002' and kind = 'reassign_owner';
insert into public.workspace_members (workspace_id, user_id, role) values
  ('11000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a5', 'admin');
select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000a2' $$,
  'the second heir deletes their account while the handover waits for the product owner');
select results_eq(
  $$ select user_id, status, attempts from public.workspace_chain_jobs
      where workspace_id = '11000000-0000-4000-8000-000000000002' and kind = 'reassign_owner' $$,
  $$ values ('00000000-0000-4000-8000-0000000000a3'::uuid, 'pending'::text, 0) $$,
  'the one handover is re-pointed to the third admin and tried afresh');
select results_eq(
  $$ select user_id from public.workspace_chain_jobs
      where workspace_id = '11000000-0000-4000-8000-000000000001' and kind = 'reassign_owner' $$,
  $$ values ('00000000-0000-4000-8000-0000000000a5'::uuid) $$,
  'and acme''s own handover goes to its admin');

select results_eq(
  $$ select address from public.workspace_chain_jobs
      where workspace_id = '11000000-0000-4000-8000-000000000001' and kind = 'revoke'
        and address = 'C' || repeat('D', 55) and status = 'pending' $$,
  $$ values ('C' || repeat('D', 55)) $$,
  'the deleted admin''s passkey wallet is queued for revocation in acme');
select is((select count(*)::int from public.smart_wallets
            where user_id in ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2')),
  0, 'and the deleted heirs'' wallet records are gone');

-- An editor of someone else's personal workspace loses that role on-chain too.
insert into auth.users (id, email, email_confirmed_at)
  values ('00000000-0000-4000-8000-0000000000a9', 'guest@example.com', now());
insert into public.wallet_accounts (address, user_id) values ('G' || repeat('G', 55), '00000000-0000-4000-8000-0000000000a9');
insert into public.workspace_members (workspace_id, user_id, role)
  select w.id, '00000000-0000-4000-8000-0000000000a9', 'editor' from public.workspaces w
   where w.is_personal and w.created_by = '00000000-0000-4000-8000-0000000000a5';
-- and has open invites, to their email and to their Stellar account
insert into public.workspace_invites (workspace_id, invitee, role, invited_by)
  select p.id, x.invitee, 'viewer', '00000000-0000-4000-8000-0000000000a5'
    from probe p, (values ('guest@example.com'), ('G' || repeat('G', 55))) x (invitee);
select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000a9' $$,
  'an editor of x''s personal workspace deletes their account');
select results_eq(
  $$ select j.kind, j.address from public.workspace_chain_jobs j
       join public.workspaces w on w.id = j.workspace_id
      where w.is_personal and w.created_by = '00000000-0000-4000-8000-0000000000a5' $$,
  $$ values ('revoke'::text, ('G' || repeat('G', 55))::text) $$,
  'and their editor role there is queued for revocation, like anywhere else');
select is((select count(*)::int from public.workspace_invites
            where invitee in ('guest@example.com', 'G' || repeat('G', 55))),
  0, 'the invites to their email and Stellar account go with the account (D-50)');


-- ---------------------------------------------------------------------------
-- Deleting an account: its invites (D-50) and its passkey wallet (D-51)
-- ---------------------------------------------------------------------------

-- n, now confirmed, joins Probe as an editor with a passkey wallet, and
-- has open invites to acme by email and by that wallet.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a8","role":"authenticated"}';
select lives_ok(
  $$ select public.accept_workspace_invite((select id from newcomer_invite)) $$,
  'the newcomer accepts the editor invite');
reset role;
insert into public.smart_wallets (user_id, network, address, created_tx) values
  ('00000000-0000-4000-8000-0000000000a8', 'testnet', 'C' || repeat('N', 55), repeat('d', 64));
insert into public.wallet_passkeys (credential_id, user_id, network, public_key, rp_id) values
  ('newcomer-key', '00000000-0000-4000-8000-0000000000a8', 'testnet',
   '\x04'::bytea || decode(repeat('11', 64), 'hex'), 'www.doqtri.xyz');
insert into public.workspace_invites (workspace_id, invitee, role, invited_by) values
  ('11000000-0000-4000-8000-000000000001', 'newcomer@example.com', 'viewer', '00000000-0000-4000-8000-0000000000a5'),
  ('11000000-0000-4000-8000-000000000001', 'C' || repeat('N', 55), 'editor', '00000000-0000-4000-8000-0000000000a5');

-- An unconfirmed account with an invited email: its deletion leaves the
-- invite for whoever owns the inbox.
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000aa', 'held@example.com');
insert into public.workspace_invites (workspace_id, invitee, role, invited_by) values
  ('11000000-0000-4000-8000-000000000001', 'held@example.com', 'viewer', '00000000-0000-4000-8000-0000000000a5');

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000a8' $$,
  'an editor holding a passkey wallet deletes their account');
select results_eq(
  $$ select kind, address, network from public.workspace_chain_jobs
      where workspace_id = (select id from probe) and address = 'C' || repeat('N', 55) $$,
  $$ values ('revoke'::text, ('C' || repeat('N', 55))::text, 'testnet'::text) $$,
  'their editor role is queued for revocation by the wallet''s C address first (D-51)');
select is((select count(*)::int from public.smart_wallets where user_id = '00000000-0000-4000-8000-0000000000a8'),
  0, 'then the wallet record is retired');
select is((select count(*)::int from public.wallet_passkeys where user_id = '00000000-0000-4000-8000-0000000000a8'),
  0, 'with its passkeys');
select is((select count(*)::int from public.workspace_invites
            where invitee in ('newcomer@example.com', 'C' || repeat('N', 55))),
  0, 'the invites to their email and passkey wallet are deleted (D-50)');
select is((select count(*)::int from public.workspace_invites where invitee = 'spam5@example.com'),
  1, 'invites to other people stay');

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000aa' $$,
  'an unconfirmed account deletes itself');
select is((select count(*)::int from public.workspace_invites where invitee = 'held@example.com'),
  1, 'and the invite to the email it never confirmed stays open');


-- ---------------------------------------------------------------------------
-- Deleting an account whose personal workspace holds an anchored note
-- ---------------------------------------------------------------------------

-- k holds a passkey wallet and anchored a personal note through the relay.
insert into auth.users (id, email, email_confirmed_at)
  values ('00000000-0000-4000-8000-0000000000ab', 'anchored@example.com', now());
insert into public.smart_wallets (user_id, network, address, created_tx) values
  ('00000000-0000-4000-8000-0000000000ab', 'testnet', 'C' || repeat('K', 55), repeat('e', 64));
insert into public.documents (id, user_id, workspace_id, title, markdown)
  select '31000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000ab', w.id, 'Kept', '# Kept'
    from public.workspaces w
   where w.is_personal and w.created_by = '00000000-0000-4000-8000-0000000000ab';
insert into public.chain_writes (network, tx_hash, document_id, fn, owner) values
  ('testnet', repeat('f', 64), '31000000-0000-4000-8000-000000000001', 'anchor', 'C' || repeat('K', 55));

select throws_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000ab' $$,
  '23001', 'this account''s personal workspace holds 1 note(s) anchored on Stellar',
  'an account whose personal note is anchored is refused, and told why');
select is((select count(*)::int from public.smart_wallets where user_id = '00000000-0000-4000-8000-0000000000ab'),
  1, 'its passkey wallet is kept');
select is((select count(*)::int from public.documents where id = '31000000-0000-4000-8000-000000000001'),
  1, 'and so is the note, with its record');

delete from public.chain_writes where document_id = '31000000-0000-4000-8000-000000000001';
select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000ab' $$,
  'with nothing anchored, the same account deletes itself (D-51)');

select * from finish();
rollback;
