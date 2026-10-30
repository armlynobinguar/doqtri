-- pgTAP tests for 20261025131000_qdit_milestone_approvals.sql (WP-3.1):
-- qdit_milestone_approvals and qdit_milestone_approval_misses.
--
-- Run against a database that has every migration applied and the pgtap
-- extension available, e.g. a Supabase branch or a local stack:
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/qdit_milestone_approvals.test.sql
--
-- Everything runs in one transaction that is rolled back. The webhook and
-- the re-check write with the service role; the audit page reads with it.

begin;
create extension if not exists pgtap with schema extensions;

select plan(31);

-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select has_table('public', 'qdit_milestone_approvals', 'qdit_milestone_approvals exists');
select col_is_pk('public', 'qdit_milestone_approvals',
  array['network', 'contract_id', 'project_id', 'milestone_id', 'version'],
  'one row per approved milestone version on one contract');
select is((select relrowsecurity from pg_class where oid = 'public.qdit_milestone_approvals'::regclass),
  true, 'RLS is on for qdit_milestone_approvals');
select is((select count(*)::int from pg_policies where tablename = 'qdit_milestone_approvals'),
  0, 'with no policy: nobody but the service role gets a row');
select ok(not has_table_privilege('anon', 'public.qdit_milestone_approvals', 'select'),
  'anon cannot read approvals (the audit page reads them server-side)');
select ok(not has_table_privilege('authenticated', 'public.qdit_milestone_approvals', 'select'),
  'nor can signed-in users');
select ok(not has_table_privilege('authenticated', 'public.qdit_milestone_approvals', 'insert'),
  'nor write them');
select ok(has_table_privilege('service_role', 'public.qdit_milestone_approvals', 'insert'),
  'the service role records them');
select ok(has_table_privilege('service_role', 'public.qdit_milestone_approvals', 'select'),
  'and reads them');
select ok(not has_table_privilege('service_role', 'public.qdit_milestone_approvals', 'update'),
  'but cannot change one');
select ok(not has_table_privilege('service_role', 'public.qdit_milestone_approvals', 'delete'),
  'nor delete one');
select has_index('public', 'qdit_milestone_approvals', 'qdit_milestone_approvals_milestone_idx',
  'approvals are looked up by milestone');

select has_table('public', 'qdit_milestone_approval_misses', 'qdit_milestone_approval_misses exists');
select col_is_pk('public', 'qdit_milestone_approval_misses',
  array['network', 'contract_id', 'project_id', 'milestone_id', 'version'],
  'one miss per approval key');
select is((select relrowsecurity from pg_class where oid = 'public.qdit_milestone_approval_misses'::regclass),
  true, 'RLS is on for qdit_milestone_approval_misses');
select ok(not has_table_privilege('anon', 'public.qdit_milestone_approval_misses', 'select')
          and not has_table_privilege('authenticated', 'public.qdit_milestone_approval_misses', 'select')
          and not has_table_privilege('authenticated', 'public.qdit_milestone_approval_misses', 'insert'),
  'browsers can neither read nor write misses');
select ok(has_table_privilege('service_role', 'public.qdit_milestone_approval_misses', 'insert')
          and has_table_privilege('service_role', 'public.qdit_milestone_approval_misses', 'select'),
  'the service role records and reads them');
select ok(not has_column_privilege('service_role', 'public.qdit_milestone_approval_misses', 'first_missed_at', 'update')
          and not has_table_privilege('service_role', 'public.qdit_milestone_approval_misses', 'delete'),
  'but cannot move or drop the first miss');
select ok(has_column_privilege('service_role', 'public.qdit_milestone_approval_misses', 'last_attempt_at', 'update')
          and not has_column_privilege('service_role', 'public.qdit_milestone_approval_misses', 'version', 'update'),
  'it may only move the last attempt');


-- ---------------------------------------------------------------------------
-- Rows
-- ---------------------------------------------------------------------------

set local role service_role;

insert into public.qdit_milestone_approvals
  (network, contract_id, project_id, milestone_id, version, tx_hash, ledger)
values ('testnet', 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
        '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72', 2,
        '5e1f0c3a9b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a3c5e7b9d0f', 1200);

select is((select tx_hash from public.qdit_milestone_approvals
            where milestone_id = 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72' and version = 2),
  '5e1f0c3a9b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a3c5e7b9d0f', 'an approval is recorded');

-- A second lookup of the same approval adds nothing and changes nothing.
insert into public.qdit_milestone_approvals
  (network, contract_id, project_id, milestone_id, version, tx_hash, ledger)
values ('testnet', 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
        '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72', 2,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1300)
on conflict do nothing;
select is((select row(count(*), min(tx_hash))::text from public.qdit_milestone_approvals),
  '(1,5e1f0c3a9b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a3c5e7b9d0f)',
  'a repeat insert is ignored: the first approval found stands');

select lives_ok($$
  insert into public.qdit_milestone_approvals
    (network, contract_id, project_id, milestone_id, version, tx_hash, ledger)
  values ('testnet', 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
          '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72', 3,
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1400)
$$, 'a later version of the same milestone is its own approval');

select throws_ok($$
  insert into public.qdit_milestone_approvals
    (network, contract_id, project_id, milestone_id, version, tx_hash, ledger)
  values ('testnet', 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
          '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'd0a36129-8c4e-4fb5-8a71-2e9c1d5f4083', 1,
          '5E1F0C3A9B7D2E4F6A8C0B1D3E5F7A9C2B4D6E8F0A1C3E5B7D9F1A3C5E7B9D0F', 1500)
$$, '23514', null, 'transaction hashes are lowercase hex');

select throws_ok($$
  insert into public.qdit_milestone_approvals
    (network, contract_id, project_id, milestone_id, version, tx_hash, ledger)
  values ('futurenet', 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
          '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'd0a36129-8c4e-4fb5-8a71-2e9c1d5f4083', 1,
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 1500)
$$, '23514', null, 'only the contract''s two networks');

select throws_ok($$
  insert into public.qdit_milestone_approvals
    (network, contract_id, project_id, milestone_id, version, tx_hash, ledger)
  values ('testnet', 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
          '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'd0a36129-8c4e-4fb5-8a71-2e9c1d5f4083', 0,
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 1500)
$$, '23514', null, 'versions start at 1 (MilestoneRecord.version)');

select throws_ok($$
  update public.qdit_milestone_approvals set tx_hash = repeat('d', 64)
$$, '42501', null, 'the service role cannot rewrite an approval');

-- Misses: the first one stands.
insert into public.qdit_milestone_approval_misses (network, contract_id, project_id, milestone_id, version, first_missed_at)
values ('testnet', 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
        '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'd0a36129-8c4e-4fb5-8a71-2e9c1d5f4083', 1,
        '2026-10-01 00:00:00+00');
insert into public.qdit_milestone_approval_misses (network, contract_id, project_id, milestone_id, version)
values ('testnet', 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
        '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'd0a36129-8c4e-4fb5-8a71-2e9c1d5f4083', 1)
on conflict do nothing;
select is((select first_missed_at from public.qdit_milestone_approval_misses
            where milestone_id = 'd0a36129-8c4e-4fb5-8a71-2e9c1d5f4083' and version = 1),
  '2026-10-01 00:00:00+00'::timestamptz, 'a later empty lookup keeps the first miss');
select isnt((select first_missed_at from public.qdit_milestone_approval_misses
              where milestone_id = 'd0a36129-8c4e-4fb5-8a71-2e9c1d5f4083' and version = 1), null,
  'first_missed_at is set');
select throws_ok($$
  insert into public.qdit_milestone_approval_misses (network, contract_id, project_id, milestone_id, version)
  values ('testnet', 'not-a-contract', '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34',
          'd0a36129-8c4e-4fb5-8a71-2e9c1d5f4083', 2)
$$, '23514', null, 'misses take the same key checks');
select throws_ok($$
  update public.qdit_milestone_approval_misses set first_missed_at = now()
$$, '42501', null, 'the service role cannot reset a miss');
update public.qdit_milestone_approval_misses set last_attempt_at = '2026-10-02 00:00:00+00'
 where milestone_id = 'd0a36129-8c4e-4fb5-8a71-2e9c1d5f4083' and version = 1;
select is((select row(first_missed_at, last_attempt_at)::text from public.qdit_milestone_approval_misses
            where milestone_id = 'd0a36129-8c4e-4fb5-8a71-2e9c1d5f4083' and version = 1),
  (select row('2026-10-01 00:00:00+00'::timestamptz, '2026-10-02 00:00:00+00'::timestamptz)::text),
  'a rescan moves the last attempt and keeps the first miss');

reset role;
select * from finish();
rollback;
