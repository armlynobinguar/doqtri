-- pgTAP tests for 20261025120000_qdit_webhook_events.sql (WP-2.8).
--
-- Run against a database that has every migration applied and the pgtap
-- extension available, e.g. a Supabase branch or a local stack:
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/qdit_webhook_events.test.sql
--
-- Everything runs in one transaction that is rolled back. A user is "signed
-- in" by switching to the authenticated role with their id in the JWT claims.
-- The webhook and the re-check write with the service role.
--
-- Cast:
--   o   owner@example.com     owner of the team workspace "acme"
--   ed  editor@example.com    editor of acme
--   vw  viewer@example.com    viewer of acme
--   x   outsider@example.com  in no workspace but their own
--
-- Notes: Plan (acme, linked to qdit project P, heading h1 linked to
-- milestone M1, h2 to M2). M3 is in P but linked nowhere.

begin;
create extension if not exists pgtap with schema extensions;

select plan(61);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'owner@example.com'),
  ('00000000-0000-4000-8000-000000000003', 'editor@example.com'),
  ('00000000-0000-4000-8000-000000000004', 'viewer@example.com'),
  ('00000000-0000-4000-8000-000000000005', 'outsider@example.com');

insert into public.workspaces (id, name, slug, created_by) values
  ('10000000-0000-4000-8000-000000000001', 'Acme', 'acme', '00000000-0000-4000-8000-000000000001');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'editor'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'viewer');

insert into public.documents (id, user_id, workspace_id, title, markdown) values
  ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000001', 'Plan', E'# A\n# B\n# C');

insert into public.doc_project_links
  (document_id, project_id, project_name, project_slug, qdit_link_id, doc_url)
values ('30000000-0000-4000-8000-000000000001', '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34',
        'Soroban payroll', 'soroban-payroll', '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d',
        'https://doqtri.test/d/30000000-0000-4000-8000-000000000001');

insert into public.node_links
  (id, user_id, document_id, node_id, node_label, provider,
   qdit_project_id, qdit_milestone_id, qdit_link_id, qdit_state)
values
  ('40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003',
   '30000000-0000-4000-8000-000000000001', 'h1', 'B', 'qdit',
   '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
   '0e9d4c3b-2a1f-4e5d-8c7b-6a5f4e3d2c11', 'linked'),
  ('40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003',
   '30000000-0000-4000-8000-000000000001', 'h2', 'C', 'qdit',
   '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e62',
   '0e9d4c3b-2a1f-4e5d-8c7b-6a5f4e3d2c12', 'linked');


-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select has_table('public', 'qdit_webhook_events', 'qdit_webhook_events exists');
select col_is_pk('public', 'qdit_webhook_events', 'id', 'events are keyed by their id (the idempotency key)');
select is((select relrowsecurity from pg_class where oid = 'public.qdit_webhook_events'::regclass),
  true, 'RLS is on for qdit_webhook_events');
select ok(not has_table_privilege('authenticated', 'public.qdit_webhook_events', 'select'),
  'signed-in users cannot read webhook events');
select ok(not has_table_privilege('authenticated', 'public.qdit_webhook_events', 'insert'),
  'nor write them');
select ok(not has_table_privilege('anon', 'public.qdit_webhook_events', 'select'), 'nor can anon');
select ok(has_table_privilege('service_role', 'public.qdit_webhook_events', 'insert'), 'the service role writes them');

select has_table('public', 'qdit_milestone_states', 'qdit_milestone_states exists');
select is((select relrowsecurity from pg_class where oid = 'public.qdit_milestone_states'::regclass),
  true, 'RLS is on for qdit_milestone_states');
select ok(has_table_privilege('authenticated', 'public.qdit_milestone_states', 'select'),
  'signed-in users may select milestone states (RLS narrows it)');
select ok(not has_table_privilege('authenticated', 'public.qdit_milestone_states', 'insert'), 'but not insert them');
select ok(not has_table_privilege('authenticated', 'public.qdit_milestone_states', 'update'), 'nor update them');
select ok(not has_table_privilege('authenticated', 'public.qdit_milestone_states', 'delete'), 'nor delete them');

select has_column('public', 'doc_project_links', 'chain_contract_id', 'project links carry the project''s chain');

select ok(not has_function_privilege('authenticated',
  'public.claim_qdit_webhook_event(uuid, text, uuid, uuid, text, timestamptz)', 'execute'),
  'signed-in users cannot claim webhook events');
select ok(not has_function_privilege('anon',
  'public.claim_qdit_webhook_event(uuid, text, uuid, uuid, text, timestamptz)', 'execute'),
  'nor can anon');
select ok(not has_function_privilege('authenticated',
  'public.record_qdit_milestone_state(uuid, uuid, text, timestamptz, text, text, text, bigint, bigint, boolean, uuid)', 'execute'),
  'signed-in users cannot record milestone states');
select ok(has_function_privilege('service_role',
  'public.record_qdit_milestone_state(uuid, uuid, text, timestamptz, text, text, text, bigint, bigint, boolean, uuid)', 'execute'),
  'the service role records them');

select is(
  (select prosecdef from pg_proc where oid = 'public.record_qdit_milestone_state(uuid, uuid, text, timestamptz, text, text, text, bigint, bigint, boolean, uuid)'::regprocedure),
  true, 'record_qdit_milestone_state is security definer');
select is(
  (select proconfig from pg_proc where oid = 'public.claim_qdit_webhook_event(uuid, text, uuid, uuid, text, timestamptz)'::regprocedure),
  array['search_path=""'], 'claim_qdit_webhook_event pins an empty search_path');


-- ---------------------------------------------------------------------------
-- Idempotency (section 9, step 5)
-- ---------------------------------------------------------------------------

set local role service_role;

select is(public.claim_qdit_webhook_event('7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10', 'milestone.status_changed',
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61', 'submitted',
  '2026-10-24T10:00:00Z'), 'new', 'a first delivery is new');
select is(public.claim_qdit_webhook_event('7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10', 'milestone.status_changed',
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61', 'submitted',
  '2026-10-24T10:00:00Z'), 'retry', 'a repeat before it was acted on is a retry');
select is((select attempts from public.qdit_webhook_events where id = '7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10'),
  2, 'and is counted');

select is(public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
  p_qdit_status => 'submitted', p_qdit_status_at => '2026-10-24T10:00:00Z',
  p_chain_status => 'Submitted', p_chain_network => 'testnet',
  p_chain_contract_id => 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
  p_chain_version => 1, p_chain_ledger => 100,
  p_event_id => '7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10'), 'recorded', 'a linked milestone''s state is recorded');
select isnt((select processed_at from public.qdit_webhook_events where id = '7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10'),
  null, 'and its event is marked done');
select is(public.claim_qdit_webhook_event('7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10', 'milestone.status_changed',
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61', 'submitted',
  '2026-10-24T10:00:00Z'), 'done', 'a replay after that is done: nothing happens twice');

select is(
  (select row(chain_status, chain_version, chain_ledger, qdit_status)::text
     from public.qdit_milestone_states where milestone_id = 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61'),
  '(Submitted,1,100,submitted)', 'the state holds the chain read and qdit''s preview');

-- Unlinked milestones (step 6).
select is(public.claim_qdit_webhook_event('8d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10', 'milestone.status_changed',
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e63', 'approved',
  '2026-10-24T10:00:00Z'), 'new', 'an event for an unlinked milestone is claimed');
select is(public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e63',
  p_qdit_status => 'approved', p_qdit_status_at => '2026-10-24T10:00:00Z',
  p_event_id => '8d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10'), 'unlinked', 'and answered as unlinked');
select is((select count(*)::int from public.qdit_milestone_states where milestone_id = 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e63'),
  0, 'no state is kept for it');
select isnt((select processed_at from public.qdit_webhook_events where id = '8d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10'),
  null, 'and its event counts as done (ignored)');
select is(public.record_qdit_milestone_state(
  '4f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
  p_qdit_status => 'approved', p_qdit_status_at => '2026-10-24T12:00:00Z'), 'unlinked',
  'a linked milestone named under another project is unlinked too');


-- ---------------------------------------------------------------------------
-- Order (D-25): newest wins, whatever order things arrive in
-- ---------------------------------------------------------------------------

select is(public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
  p_qdit_status => 'approved', p_qdit_status_at => '2026-10-24T12:00:00Z',
  p_chain_status => 'Approved', p_chain_network => 'testnet',
  p_chain_contract_id => 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
  p_chain_version => 1, p_chain_ledger => 120), 'recorded', 'the approval is recorded');
select is(public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
  p_qdit_status => 'submitted', p_qdit_status_at => '2026-10-24T11:00:00Z',
  p_chain_status => 'Submitted', p_chain_network => 'testnet',
  p_chain_contract_id => 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
  p_chain_version => 1, p_chain_ledger => 110), 'recorded', 'an older event and an older read arrive late');
select is(
  (select row(chain_status, chain_ledger, qdit_status, qdit_status_at = '2026-10-24T12:00:00Z')::text
     from public.qdit_milestone_states where milestone_id = 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61'),
  '(Approved,120,approved,t)', 'and change nothing: the newer state stays');

select lives_ok($$ select public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
  p_chain_status => 'Approved', p_chain_network => 'testnet',
  p_chain_contract_id => 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
  p_chain_version => 1, p_chain_ledger => 120) $$, 'a read at the same ledger (a duplicate) is fine');
select is(public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
  p_qdit_status => 'approved', p_qdit_status_at => '2026-10-24T12:00:00Z', p_qdit_checked => true),
  'recorded', 'a re-check that only asked qdit');
select isnt((select qdit_checked_at from public.qdit_milestone_states where milestone_id = 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61'),
  null, 'stamps when qdit was asked');
select is((select chain_ledger from public.qdit_milestone_states where milestone_id = 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61'),
  120::bigint, 'and leaves the chain read alone');

select is(public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
  p_chain_status => 'Submitted', p_chain_network => 'testnet',
  p_chain_contract_id => 'CCCIDUCFQMTMAGESMPTB3MFW4TURS62ORSZNICFOE6MNQZO3MI7F6QRJ',
  p_chain_version => 1, p_chain_ledger => 5), 'recorded', 'a read of another contract (the project moved)');
select is((select chain_contract_id || ':' || chain_status from public.qdit_milestone_states
            where milestone_id = 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61'),
  'CCCIDUCFQMTMAGESMPTB3MFW4TURS62ORSZNICFOE6MNQZO3MI7F6QRJ:Submitted', 'replaces it, whatever the ledger');

select is(public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e62',
  p_chain_status => 'unregistered'), 'recorded', 'a project with no chain records as unregistered');
select is((select chain_status from public.qdit_milestone_states where milestone_id = 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e62'),
  'unregistered', 'and nothing else');
select is(public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e62',
  p_chain_status => 'none', p_chain_network => 'testnet',
  p_chain_contract_id => 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG', p_chain_ledger => 130),
  'recorded', 'a milestone with no record on chain records as none');
select is(public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e62',
  p_chain_status => 'Submitted', p_chain_network => 'testnet',
  p_chain_contract_id => 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
  p_chain_version => 4294967295, p_chain_ledger => 135),
  'recorded', 'a version up to u32::MAX fits');
select throws_ok($$ select public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e62',
  p_chain_status => 'Submitted', p_chain_network => 'testnet',
  p_chain_contract_id => 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
  p_chain_version => 4294967296, p_chain_ledger => 136) $$,
  '23514', null, 'and one past it is refused');

select throws_ok($$ select public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e62',
  p_chain_status => 'Approved', p_chain_network => 'testnet',
  p_chain_contract_id => 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG', p_chain_ledger => 140) $$,
  '23514', null, 'a record read without its version is refused');
select throws_ok($$ select public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e62',
  p_chain_status => 'Approved', p_chain_network => 'testnet',
  p_chain_contract_id => 'not-a-contract', p_chain_version => 1, p_chain_ledger => 140) $$,
  '23514', null, 'and so is a contract id that is not a StrKey');
select throws_ok($$ select public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e62',
  p_qdit_status => 'approved') $$,
  '22023', null, 'a qdit status needs the time it is from');
select throws_ok($$ update public.doc_project_links set chain_network = 'testnet'
                     where document_id = '30000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'a project chain names both network and contract');


-- ---------------------------------------------------------------------------
-- Who reads the states (RLS)
-- ---------------------------------------------------------------------------

reset role;
set local role authenticated;

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
select is((select count(*)::int from public.qdit_milestone_states), 2,
  'a viewer of the note reads its milestones'' states (the suggestion, D-14)');
select throws_ok($$ update public.qdit_milestone_states set chain_status = 'Approved' $$,
  '42501', null, 'but cannot change them');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is((select count(*)::int from public.qdit_milestone_states), 2, 'an editor reads them');
select throws_ok($$ select public.record_qdit_milestone_state(
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
  p_chain_status => 'unregistered') $$, '42501', null, 'and cannot record one either');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
select is((select count(*)::int from public.qdit_milestone_states), 0, 'an outsider reads none');
select throws_ok($$ select count(*) from public.qdit_webhook_events $$,
  '42501', null, 'and nobody signed in reads the events');


-- ---------------------------------------------------------------------------
-- Unlinking forgets the state; pruning
-- ---------------------------------------------------------------------------

reset role;
set local role service_role;

delete from public.node_links where id = '40000000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.qdit_milestone_states where milestone_id = 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61'),
  0, 'unlinking a heading forgets its milestone''s state');
delete from public.doc_project_links where document_id = '30000000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.qdit_milestone_states), 0,
  'unlinking the note''s project forgets the rest (through the cascade)');

update public.qdit_webhook_events set received_at = now() - interval '31 days'
 where id = '8d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10';
select is(public.claim_qdit_webhook_event('9d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10', 'milestone.status_changed',
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61', 'approved',
  '2026-10-24T13:00:00Z'), 'new', 'another delivery');
select is((select count(*)::int from public.qdit_webhook_events where id = '8d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10'),
  0, 'drops events older than 30 days');
select is((select count(*)::int from public.qdit_webhook_events where id = '7d0f8a52-3c1e-4b6a-9f21-5e8c0d4b2a10'),
  1, 'and keeps recent ones (well past the 7 days the contract asks for)');

reset role;
select * from finish();
rollback;
