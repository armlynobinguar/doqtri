-- pgTAP tests for 20261026110000_qdit_approval_incomplete_scans.sql
-- (WP-2.13): qdit_milestone_approval_incomplete_scans.
--
-- Run against a database that has every migration applied and the pgtap
-- extension available, e.g. a Supabase branch or a local stack:
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/qdit_approval_incomplete_scans.test.sql
--
-- Everything runs in one transaction that is rolled back. The webhook and
-- the re-check write with the service role.

begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select has_table('public', 'qdit_milestone_approval_incomplete_scans', 'qdit_milestone_approval_incomplete_scans exists');
select col_is_pk('public', 'qdit_milestone_approval_incomplete_scans',
  array['network', 'contract_id', 'project_id', 'milestone_id', 'version'],
  'one row per approval key, the same key as the misses');
select is((select relrowsecurity from pg_class where oid = 'public.qdit_milestone_approval_incomplete_scans'::regclass),
  true, 'RLS is on');
select is((select count(*)::int from pg_policies where tablename = 'qdit_milestone_approval_incomplete_scans'),
  0, 'with no policy: nobody but the service role gets a row');
select ok(not has_table_privilege('anon', 'public.qdit_milestone_approval_incomplete_scans', 'select')
          and not has_table_privilege('authenticated', 'public.qdit_milestone_approval_incomplete_scans', 'select')
          and not has_table_privilege('authenticated', 'public.qdit_milestone_approval_incomplete_scans', 'insert'),
  'browsers can neither read nor write them');
select ok(has_table_privilege('service_role', 'public.qdit_milestone_approval_incomplete_scans', 'insert')
          and has_table_privilege('service_role', 'public.qdit_milestone_approval_incomplete_scans', 'select'),
  'the service role records and reads them');
select ok(has_column_privilege('service_role', 'public.qdit_milestone_approval_incomplete_scans', 'last_attempt_at', 'update')
          and not has_column_privilege('service_role', 'public.qdit_milestone_approval_incomplete_scans', 'version', 'update')
          and not has_table_privilege('service_role', 'public.qdit_milestone_approval_incomplete_scans', 'delete'),
  'it may only move the last attempt');

-- ---------------------------------------------------------------------------
-- Rows
-- ---------------------------------------------------------------------------

set local role service_role;

insert into public.qdit_milestone_approval_incomplete_scans (network, contract_id, project_id, milestone_id, version)
values ('testnet', 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
        '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72', 2);
select isnt((select last_attempt_at from public.qdit_milestone_approval_incomplete_scans
              where milestone_id = 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72' and version = 2), null,
  'an incomplete scan is recorded with its time');

-- The point of the table: it never touches the give-up clock.
select is((select count(*)::int from public.qdit_milestone_approval_misses
            where milestone_id = 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72'),
  0, 'recording an incomplete scan records no miss, so the 8-day clock does not start');

-- A repeat insert (two instances racing) is ignored; the update moves the time.
insert into public.qdit_milestone_approval_incomplete_scans (network, contract_id, project_id, milestone_id, version, last_attempt_at)
values ('testnet', 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
        '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72', 2, '2026-01-01 00:00:00+00')
on conflict do nothing;
select is((select count(*)::int from public.qdit_milestone_approval_incomplete_scans), 1,
  'a repeat insert adds no second row');
update public.qdit_milestone_approval_incomplete_scans set last_attempt_at = '2026-10-26 12:00:00+00'
 where milestone_id = 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72' and version = 2;
select is((select last_attempt_at from public.qdit_milestone_approval_incomplete_scans
            where milestone_id = 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72' and version = 2),
  '2026-10-26 12:00:00+00'::timestamptz, 'a later incomplete scan moves the last attempt');

select throws_ok($$
  insert into public.qdit_milestone_approval_incomplete_scans (network, contract_id, project_id, milestone_id, version)
  values ('testnet', 'not-a-contract', '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34',
          'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72', 3)
$$, '23514', null, 'the same key checks as the misses: contract ids');
select throws_ok($$
  insert into public.qdit_milestone_approval_incomplete_scans (network, contract_id, project_id, milestone_id, version)
  values ('testnet', 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
          '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72', 0)
$$, '23514', null, 'and versions from 1');
select throws_ok($$
  delete from public.qdit_milestone_approval_incomplete_scans
$$, '42501', null, 'the service role cannot delete one');

reset role;
select * from finish();
rollback;
