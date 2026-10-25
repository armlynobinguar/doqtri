-- pgTAP tests for 20261026120001_qdit_approval_incomplete_first_at.sql
-- (WP-1.12, D-92): qdit_milestone_approval_incomplete_scans keeps when a
-- lookup first ran out of budget, set once and never moved.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/qdit_approval_incomplete_first_at.test.sql
--
-- One transaction, rolled back. The webhook and the re-check write with the
-- service role.

begin;
create extension if not exists pgtap with schema extensions;

select plan(8);

select has_column('public', 'qdit_milestone_approval_incomplete_scans', 'first_incomplete_at',
  'incomplete scans keep their first time');
select col_not_null('public', 'qdit_milestone_approval_incomplete_scans', 'first_incomplete_at',
  'which is never null');
select ok(has_column_privilege('service_role', 'public.qdit_milestone_approval_incomplete_scans', 'first_incomplete_at', 'insert')
          and not has_column_privilege('service_role', 'public.qdit_milestone_approval_incomplete_scans', 'first_incomplete_at', 'update')
          and has_column_privilege('service_role', 'public.qdit_milestone_approval_incomplete_scans', 'last_attempt_at', 'update'),
  'the service role sets it on insert and may still move only the last attempt');

set local role service_role;

insert into public.qdit_milestone_approval_incomplete_scans (network, contract_id, project_id, milestone_id, version)
values ('testnet', 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
        '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72', 2);
select is((select first_incomplete_at = last_attempt_at from public.qdit_milestone_approval_incomplete_scans
            where milestone_id = 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72' and version = 2),
  true, 'the first incomplete scan sets both times');

update public.qdit_milestone_approval_incomplete_scans set last_attempt_at = now() + interval '2 hours'
 where milestone_id = 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72' and version = 2;
select is((select first_incomplete_at < last_attempt_at from public.qdit_milestone_approval_incomplete_scans
            where milestone_id = 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72' and version = 2),
  true, 'a later one moves the last attempt and leaves the first');

select throws_ok($$
  update public.qdit_milestone_approval_incomplete_scans set first_incomplete_at = now() + interval '1 day'
   where milestone_id = 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72'
$$, '42501', null, 'the first time cannot be moved');

-- Two instances racing: the repeat insert is ignored and the first time stands.
insert into public.qdit_milestone_approval_incomplete_scans
  (network, contract_id, project_id, milestone_id, version, first_incomplete_at)
values ('testnet', 'CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG',
        '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72', 2, now() + interval '3 days')
on conflict do nothing;
select is((select first_incomplete_at <= now() from public.qdit_milestone_approval_incomplete_scans
            where milestone_id = 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72' and version = 2),
  true, 'a repeat insert does not move it');

select is((select count(*)::int from public.qdit_milestone_approval_misses
            where milestone_id = 'c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72'),
  0, 'and none of it starts the miss clock');

reset role;
select * from finish();
rollback;
