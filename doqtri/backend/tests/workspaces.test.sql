-- pgTAP tests for 20261024120000_create_workspaces.sql (WP-1.1).
--
-- Run against a database that has every migration applied and the pgtap
-- extension available, e.g. a Supabase branch or a local stack:
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/workspaces.test.sql
--
-- Everything runs in one transaction that is rolled back, so it leaves no
-- trace. Users are created by inserting into auth.users, as the auth server
-- would; that also exercises the new-account trigger. A user is "signed in"
-- by switching to the authenticated role with their id in the JWT claims,
-- which is what auth.uid() reads.
--
-- Cast:
--   o  owner@example.com     owner of the team workspace "acme"
--   ad admin@example.com     admin of acme
--   ed editor@example.com    editor of acme
--   vw viewer@example.com    viewer of acme
--   x  outsider@example.com  in no workspace but their own
--   w  a wallet account (synthetic @stellar.doqtri.local email)
--   n  an account with no email
--   z  a "pre-existing" account with a document and no workspace yet

begin;
create extension if not exists pgtap with schema extensions;

select plan(92);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'owner@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'admin@example.com'),
  ('00000000-0000-4000-8000-000000000003', 'editor@example.com'),
  ('00000000-0000-4000-8000-000000000004', 'viewer@example.com'),
  ('00000000-0000-4000-8000-000000000005', 'outsider@example.com'),
  ('00000000-0000-4000-8000-000000000006', 'g' || repeat('a', 55) || '@stellar.doqtri.local'),
  ('00000000-0000-4000-8000-000000000007', null),
  ('00000000-0000-4000-8000-000000000008', 'legacy@example.com');


-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select ok((select relrowsecurity from pg_class where oid = 'public.workspaces'::regclass),
  'RLS is enabled on workspaces');
select ok((select relrowsecurity from pg_class where oid = 'public.workspace_members'::regclass),
  'RLS is enabled on workspace_members');
-- WP-1.2 adds this column and replaces this assertion with its own tests.
select hasnt_column('public', 'documents', 'workspace_id',
  'documents are not moved to workspaces yet (WP-1.2)');

select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('is_workspace_member', 'handle_new_workspace',
                        'workspace_members_keep_owner', 'ensure_personal_workspace',
                        'handle_new_user_workspace')),
  'every security definer function pins search_path to empty');

select ok(not has_function_privilege('anon',
  'public.is_workspace_member(uuid, public.workspace_role)', 'execute'),
  'anon cannot call is_workspace_member');
select ok(has_function_privilege('authenticated',
  'public.is_workspace_member(uuid, public.workspace_role)', 'execute'),
  'authenticated can call is_workspace_member');
select ok(not has_function_privilege('authenticated',
  'public.ensure_personal_workspace(uuid)', 'execute'),
  'authenticated cannot call ensure_personal_workspace');
select ok(has_function_privilege('service_role',
  'public.ensure_personal_workspace(uuid)', 'execute'),
  'service_role can call ensure_personal_workspace');
select ok(not has_function_privilege('authenticated',
  'public.handle_new_workspace()', 'execute'),
  'authenticated cannot call the owner bootstrap trigger function');

select is(public.workspace_role_rank('viewer'), 1, 'viewer ranks 1');
select is(public.workspace_role_rank('owner'), 4, 'owner ranks 4');


-- ---------------------------------------------------------------------------
-- New accounts get a personal workspace
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.workspaces
    where is_personal and created_by::text like '00000000-0000-4000-8000-00000000000_'),
  8, 'every new account gets one personal workspace');
select is(
  (select count(*)::int
     from public.workspaces w
     join public.workspace_members m on m.workspace_id = w.id
    where w.is_personal and m.user_id = w.created_by and m.role = 'owner'
      and w.created_by::text like '00000000-0000-4000-8000-00000000000_'),
  8, 'and owns it');
select is(
  (select name from public.workspaces
    where is_personal and created_by = '00000000-0000-4000-8000-000000000001'),
  'owner', 'a personal workspace is named after the email local part');
select is(
  (select name from public.workspaces
    where is_personal and created_by = '00000000-0000-4000-8000-000000000006'),
  'Personal', 'a wallet account''s workspace is named Personal');
select is(
  (select name from public.workspaces
    where is_personal and created_by = '00000000-0000-4000-8000-000000000007'),
  'Personal', 'an account without email gets Personal');
select matches(
  (select slug from public.workspaces
    where is_personal and created_by = '00000000-0000-4000-8000-000000000001'),
  '^personal-[0-9a-f]{8}$', 'a personal slug is random, not the email');


-- ---------------------------------------------------------------------------
-- Creating a workspace (signed in as o)
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  $$ insert into public.workspaces (id, name, slug)
     values ('10000000-0000-4000-8000-000000000001', 'Acme', 'acme') returning id $$,
  'any user can create a workspace and read it back');
select is(
  (select created_by from public.workspaces where id = '10000000-0000-4000-8000-000000000001'),
  '00000000-0000-4000-8000-000000000001'::uuid, 'created_by defaults to the caller');
select results_eq(
  $$ select user_id, role::text from public.workspace_members
      where workspace_id = '10000000-0000-4000-8000-000000000001' $$,
  $$ values ('00000000-0000-4000-8000-000000000001'::uuid, 'owner') $$,
  'the creator becomes its only owner');
select throws_ok(
  $$ insert into public.workspaces (name, slug, created_by)
     values ('Theirs', 'theirs', '00000000-0000-4000-8000-000000000005') $$,
  '42501', null, 'cannot create a workspace on behalf of someone else');
select throws_ok(
  $$ insert into public.workspaces (name, slug, is_personal)
     values ('Mine', 'mine', true) $$,
  '42501', null, 'cannot create a personal workspace');
select lives_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role) values
       ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'admin'),
       ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'editor'),
       ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'viewer') $$,
  'the owner adds an admin, an editor and a viewer');


-- ---------------------------------------------------------------------------
-- Read paths
-- ---------------------------------------------------------------------------

-- owner
select is((select count(*)::int from public.workspaces where id = '10000000-0000-4000-8000-000000000001'),
  1, 'owner reads the workspace');
select is((select count(*)::int from public.workspace_members where workspace_id = '10000000-0000-4000-8000-000000000001'),
  4, 'owner reads the whole roster');

-- admin
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*)::int from public.workspaces where id = '10000000-0000-4000-8000-000000000001'),
  1, 'admin reads the workspace');
select is((select count(*)::int from public.workspace_members where workspace_id = '10000000-0000-4000-8000-000000000001'),
  4, 'admin reads the whole roster');
select ok(public.is_workspace_member('10000000-0000-4000-8000-000000000001', 'admin'),
  'admin is a member at admin rank');
select ok(not public.is_workspace_member('10000000-0000-4000-8000-000000000001', 'owner'),
  'admin is not a member at owner rank');

-- editor
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is((select count(*)::int from public.workspaces where id = '10000000-0000-4000-8000-000000000001'),
  1, 'editor reads the workspace');
select is((select count(*)::int from public.workspace_members where workspace_id = '10000000-0000-4000-8000-000000000001'),
  4, 'editor reads the whole roster');
select ok(public.is_workspace_member('10000000-0000-4000-8000-000000000001', 'editor'),
  'editor is a member at editor rank');
select ok(not public.is_workspace_member('10000000-0000-4000-8000-000000000001', 'admin'),
  'editor is not a member at admin rank');

-- viewer
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
select is((select count(*)::int from public.workspaces where id = '10000000-0000-4000-8000-000000000001'),
  1, 'viewer reads the workspace');
select is((select count(*)::int from public.workspace_members where workspace_id = '10000000-0000-4000-8000-000000000001'),
  4, 'viewer reads the whole roster');
select is((select count(*)::int from public.workspaces),
  2, 'viewer sees acme and their own personal workspace, nothing else');
select ok(public.is_workspace_member('10000000-0000-4000-8000-000000000001'),
  'viewer is a member at the default (viewer) rank');
select ok(not public.is_workspace_member('10000000-0000-4000-8000-000000000001', 'editor'),
  'viewer is not a member at editor rank');

-- outsider
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
select is((select count(*)::int from public.workspaces where id = '10000000-0000-4000-8000-000000000001'),
  0, 'outsider cannot read the workspace');
select is((select count(*)::int from public.workspace_members where workspace_id = '10000000-0000-4000-8000-000000000001'),
  0, 'outsider cannot read the roster');
select is((select count(*)::int from public.workspaces),
  1, 'outsider sees only their own personal workspace');
select is((select count(*)::int from public.workspace_members),
  1, 'outsider sees only their own membership');
select ok(not public.is_workspace_member('10000000-0000-4000-8000-000000000001'),
  'outsider is not a member');

-- anon
reset role;
set local role anon;
select is((select count(*)::int from public.workspaces), 0, 'anon reads no workspaces');
select is((select count(*)::int from public.workspace_members), 0, 'anon reads no memberships');
reset role;


-- ---------------------------------------------------------------------------
-- Write paths: the workspace row
-- ---------------------------------------------------------------------------

set local role authenticated;

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
with u as (update public.workspaces set name = 'Pwned'
            where id = '10000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 0, 'outsider cannot rename the workspace') from u;
with u as (update public.workspaces set name = 'Pwned'
            where created_by = '00000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 0, 'outsider cannot rename someone''s personal workspace') from u;

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
with u as (update public.workspaces set name = 'Viewer was here'
            where id = '10000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 0, 'viewer cannot rename the workspace') from u;

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
with u as (update public.workspaces set name = 'Editor was here'
            where id = '10000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 0, 'editor cannot rename the workspace') from u;

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
with u as (update public.workspaces set name = 'Acme Inc'
            where id = '10000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 1, 'admin renames the workspace') from u;
select throws_ok(
  $$ update public.workspaces set is_personal = true
      where id = '10000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'admin cannot make a team workspace personal');
select throws_ok(
  $$ update public.workspaces set created_by = '00000000-0000-4000-8000-000000000002'
      where id = '10000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'admin cannot rewrite who created the workspace');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
with d as (delete from public.workspaces
            where id = '10000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 0, 'not even the owner deletes a workspace from the browser') from d;


-- ---------------------------------------------------------------------------
-- Write paths: membership
-- ---------------------------------------------------------------------------

-- outsider
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
select throws_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     values ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000005', 'viewer') $$,
  '42501', null, 'outsider cannot add themselves');

-- viewer
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     values ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000005', 'viewer') $$,
  '42501', null, 'viewer cannot add members');
with u as (update public.workspace_members set role = 'admin'
            where workspace_id = '10000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-000000000004' returning 1)
select is(count(*)::int, 0, 'viewer cannot promote themselves') from u;

-- editor
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     values ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000005', 'viewer') $$,
  '42501', null, 'editor cannot add members');
with u as (update public.workspace_members set role = 'editor'
            where workspace_id = '10000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-000000000004' returning 1)
select is(count(*)::int, 0, 'editor cannot change another member''s role') from u;
with d as (delete from public.workspace_members
            where workspace_id = '10000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-000000000004' returning 1)
select is(count(*)::int, 0, 'editor cannot remove another member') from d;

-- admin
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     values ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000005', 'owner') $$,
  '42501', null, 'admin cannot add an owner');
select lives_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     values ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000005', 'viewer') $$,
  'admin adds a viewer');
with u as (update public.workspace_members set role = 'editor'
            where workspace_id = '10000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-000000000005' returning 1)
select is(count(*)::int, 1, 'admin promotes a viewer to editor') from u;
select throws_ok(
  $$ update public.workspace_members set role = 'owner'
      where workspace_id = '10000000-0000-4000-8000-000000000001'
        and user_id = '00000000-0000-4000-8000-000000000003' $$,
  '42501', null, 'admin cannot make anyone an owner');
with u as (update public.workspace_members set role = 'viewer'
            where workspace_id = '10000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 0, 'admin cannot demote the owner') from u;
with d as (delete from public.workspace_members
            where workspace_id = '10000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 0, 'admin cannot remove the owner') from d;
with d as (delete from public.workspace_members
            where workspace_id = '10000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-000000000005' returning 1)
select is(count(*)::int, 1, 'admin removes a member') from d;

-- the removed member loses access at once
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
select is((select count(*)::int from public.workspaces where id = '10000000-0000-4000-8000-000000000001'),
  0, 'a removed member cannot read the workspace any more');

-- viewer leaves, and the owner adds them back
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
with d as (delete from public.workspace_members
            where workspace_id = '10000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-000000000004' returning 1)
select is(count(*)::int, 1, 'a member can leave') from d;

-- owner
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     values ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'viewer') $$,
  'owner adds the viewer back');
select throws_ok(
  $$ delete from public.workspace_members
      where workspace_id = '10000000-0000-4000-8000-000000000001'
        and user_id = '00000000-0000-4000-8000-000000000001' $$,
  '23514', 'a workspace must keep at least one owner', 'the last owner cannot leave');
select throws_ok(
  $$ update public.workspace_members set role = 'admin'
      where workspace_id = '10000000-0000-4000-8000-000000000001'
        and user_id = '00000000-0000-4000-8000-000000000001' $$,
  '23514', 'a workspace must keep at least one owner', 'the last owner cannot step down');
select throws_ok(
  $$ delete from public.workspace_members
      where workspace_id = '10000000-0000-4000-8000-000000000001' $$,
  '23514', 'a workspace must keep at least one owner', 'the owner cannot empty the roster');
select throws_ok(
  $$ update public.workspace_members
        set workspace_id = (select id from public.workspaces
                             where is_personal and created_by = '00000000-0000-4000-8000-000000000001')
      where workspace_id = '10000000-0000-4000-8000-000000000001'
        and user_id = '00000000-0000-4000-8000-000000000003' $$,
  '23514', 'a workspace membership cannot move to another workspace or user',
  'a membership cannot be moved to another workspace');
with u as (update public.workspace_members set role = 'owner'
            where workspace_id = '10000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-000000000002' returning 1)
select is(count(*)::int, 1, 'the owner makes the admin a second owner') from u;
with d as (delete from public.workspace_members
            where workspace_id = '10000000-0000-4000-8000-000000000001'
              and user_id = '00000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 1, 'with another owner in place, the first owner can leave') from d;
select is((select count(*)::int from public.workspaces where id = '10000000-0000-4000-8000-000000000001'),
  1, 'the creator who left still sees the workspace row they created');
select is((select count(*)::int from public.workspace_members where workspace_id = '10000000-0000-4000-8000-000000000001'),
  0, 'but no longer its roster');

reset role;


-- ---------------------------------------------------------------------------
-- Backfill
--
-- z stands for an account that existed before this migration: their trigger-
-- made workspace is removed, and they own a document.
-- ---------------------------------------------------------------------------

insert into public.documents (user_id, title, markdown)
values ('00000000-0000-4000-8000-000000000008', 'Legacy note', '# Legacy');
delete from public.workspaces
 where is_personal and created_by = '00000000-0000-4000-8000-000000000008';

select is(
  (select count(*)::int from public.workspaces
    where is_personal and created_by = '00000000-0000-4000-8000-000000000008'),
  0, 'the legacy account starts without a workspace');

-- The backfill statement from the migration, verbatim.
select lives_ok(
  $$ select count(public.ensure_personal_workspace(u.id))
       from (select id from auth.users order by created_at) u $$,
  'the backfill runs');
select is(
  (select count(*)::int
     from public.workspaces w
     join public.workspace_members m on m.workspace_id = w.id
    where w.is_personal and m.user_id = w.created_by and m.role = 'owner'
      and w.created_by = '00000000-0000-4000-8000-000000000008'),
  1, 'the legacy account now owns a personal workspace');
select is(
  (select name from public.workspaces
    where is_personal and created_by = '00000000-0000-4000-8000-000000000008'),
  'legacy', 'named after their email');
select is(
  (select count(*)::int from public.documents d
    where not exists (select 1 from public.workspaces w
                       where w.is_personal and w.created_by = d.user_id)),
  0, 'every document owner has a personal workspace');

create temp table ws_before as select id, name, slug from public.workspaces;
create temp table wm_before as select workspace_id, user_id, role from public.workspace_members;
select lives_ok(
  $$ select count(public.ensure_personal_workspace(u.id))
       from (select id from auth.users order by created_at) u $$,
  'the backfill runs a second time');
select set_eq('select id, name, slug from public.workspaces', 'select * from ws_before',
  'a second run creates or changes no workspace');
select set_eq('select workspace_id, user_id, role from public.workspace_members', 'select * from wm_before',
  'a second run creates or changes no membership');
select is(
  public.ensure_personal_workspace('00000000-0000-4000-8000-000000000008'),
  (select id from public.workspaces where is_personal and created_by = '00000000-0000-4000-8000-000000000008'),
  'ensure_personal_workspace returns the existing workspace');

-- Their document is still theirs, under the unchanged policies.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000008","role":"authenticated"}';
select is((select count(*)::int from public.documents), 1, 'the legacy account still reads its document');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*)::int from public.documents), 0, 'and nobody else does');
reset role;


-- ---------------------------------------------------------------------------
-- Deleting an account
-- ---------------------------------------------------------------------------

create temp table vw_personal as
  select id from public.workspaces
   where is_personal and created_by = '00000000-0000-4000-8000-000000000004';

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-000000000004' $$,
  'an account that is the last owner of its personal workspace can be deleted');
select is(
  (select count(*)::int from public.workspace_members where user_id = '00000000-0000-4000-8000-000000000004'),
  0, 'its memberships go with it');
select is(
  (select created_by from public.workspaces where id = (select id from vw_personal)),
  null, 'its personal workspace stays, with created_by cleared');
select is(
  (select count(*)::int from public.workspaces where id = '10000000-0000-4000-8000-000000000001'),
  1, 'team workspaces it belonged to are untouched');


select * from finish();
rollback;
