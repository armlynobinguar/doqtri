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

select plan(147);

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
-- WP-1.2 moved documents into workspaces; workspace_documents.test.sql
-- covers that.
select has_column('public', 'documents', 'workspace_id',
  'documents belong to workspaces (WP-1.2)');

select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('is_workspace_member', 'handle_new_workspace',
                        'workspaces_before_update', 'workspace_members_keep_owner',
                        'create_workspace', 'restore_personal_owner',
                        'ensure_personal_workspace', 'handle_new_user_workspace',
                        'handle_deleted_user_workspaces')),
  'every security definer function pins search_path to empty');
select ok(
  (select not p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_proc p
    where p.oid = 'public.workspace_members_before_write()'::regprocedure),
  'the joined_at guard runs as the writer, so it sees who is writing');
select ok(not has_function_privilege('authenticated',
  'public.workspace_members_before_write()', 'execute'),
  'authenticated cannot call the joined_at guard trigger function');

select ok(not has_function_privilege('anon',
  'public.is_workspace_member(uuid, public.workspace_role)', 'execute'),
  'anon cannot call is_workspace_member');
select ok(has_function_privilege('authenticated',
  'public.is_workspace_member(uuid, public.workspace_role)', 'execute'),
  'authenticated can call is_workspace_member');
select ok(not has_function_privilege('anon',
  'public.create_workspace(text, text)', 'execute'),
  'anon cannot call create_workspace');
select ok(has_function_privilege('authenticated',
  'public.create_workspace(text, text)', 'execute'),
  'authenticated can call create_workspace');
select ok(not has_function_privilege('authenticated',
  'public.restore_personal_owner(uuid, uuid)', 'execute'),
  'authenticated cannot call restore_personal_owner');
select ok(not has_function_privilege('authenticated',
  'public.ensure_personal_workspace(uuid)', 'execute'),
  'authenticated cannot call ensure_personal_workspace');
select ok(has_function_privilege('service_role',
  'public.ensure_personal_workspace(uuid)', 'execute'),
  'service_role can call ensure_personal_workspace');
select ok(not has_function_privilege('authenticated',
  'public.handle_new_workspace()', 'execute'),
  'authenticated cannot call the owner bootstrap trigger function');
select ok(not has_function_privilege('authenticated',
  'public.handle_deleted_user_workspaces()', 'execute'),
  'authenticated cannot call the account deletion trigger function');

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
-- Creating a workspace
-- ---------------------------------------------------------------------------

-- acme is inserted directly by the migration role so that it has a known id;
-- on_workspace_created still runs. The browser path, create_workspace(), is
-- tested right after, signed in as o.
insert into public.workspaces (id, name, slug, created_by)
values ('10000000-0000-4000-8000-000000000001', 'Acme', 'acme',
        '00000000-0000-4000-8000-000000000001');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

select results_eq(
  $$ select user_id, role::text from public.workspace_members
      where workspace_id = '10000000-0000-4000-8000-000000000001' $$,
  $$ values ('00000000-0000-4000-8000-000000000001'::uuid, 'owner') $$,
  'the creator becomes its only owner');

select is(
  (select slug from public.create_workspace('  Side project ', 'side-project')),
  'side-project', 'any user creates a workspace with create_workspace and gets it back');
select results_eq(
  $$ select name, created_by, is_personal from public.workspaces where slug = 'side-project' $$,
  $$ values ('Side project'::text, '00000000-0000-4000-8000-000000000001'::uuid, false) $$,
  'it is trimmed, created by the caller and not personal');
select results_eq(
  $$ select m.user_id, m.role::text
       from public.workspace_members m
       join public.workspaces w on w.id = m.workspace_id
      where w.slug = 'side-project' $$,
  $$ values ('00000000-0000-4000-8000-000000000001'::uuid, 'owner') $$,
  'and the caller is its only owner');
select throws_ok(
  $$ select public.create_workspace('Copycat', 'acme') $$,
  '23505', null, 'create_workspace refuses a taken slug');
select throws_ok(
  $$ select public.create_workspace('Bad', 'Not A Slug') $$,
  '23514', null, 'create_workspace refuses an invalid slug');
select throws_ok(
  $$ insert into public.workspaces (name, slug) values ('Direct', 'direct') $$,
  '42501', null, 'a workspace cannot be inserted directly');
select throws_ok(
  $$ insert into public.workspaces (name, slug, is_personal)
     values ('Mine', 'mine', true) $$,
  '42501', null, 'nor a personal one');

select throws_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     values ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000005', 'owner') $$,
  '42501', null, 'not even the owner adds someone straight in as owner');
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
select throws_ok(
  $$ update public.workspaces set created_by = null
      where id = '10000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'admin cannot clear who created the workspace');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
with d as (delete from public.workspaces
            where id = '10000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 0, 'not even the owner deletes a workspace from the browser') from d;
select throws_ok(
  $$ update public.workspaces set created_by = null
      where is_personal and created_by = '00000000-0000-4000-8000-000000000001' $$,
  '23514', null, 'an owner cannot detach their personal workspace from themselves');


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
select throws_ok(
  $$ update public.workspace_members set joined_at = '1970-01-01'
      where workspace_id = '10000000-0000-4000-8000-000000000001'
        and user_id = '00000000-0000-4000-8000-000000000002' $$,
  '23514', 'a workspace membership''s joined_at cannot change',
  'admin cannot backdate their own membership');
select throws_ok(
  $$ update public.workspace_members set joined_at = '1970-01-01'
      where workspace_id = '10000000-0000-4000-8000-000000000001'
        and user_id = '00000000-0000-4000-8000-000000000003' $$,
  '23514', 'a workspace membership''s joined_at cannot change',
  'nor anyone else''s');

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
  $$ update public.workspace_members set joined_at = '1970-01-01'
      where workspace_id = '10000000-0000-4000-8000-000000000001'
        and user_id = '00000000-0000-4000-8000-000000000002' $$,
  '23514', 'a workspace membership''s joined_at cannot change',
  'not even the owner rewrites when someone joined');
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
  0, 'a creator who left no longer sees the workspace row (D-16)');
select is((select count(*)::int from public.workspace_members where workspace_id = '10000000-0000-4000-8000-000000000001'),
  0, 'nor its roster');


-- ---------------------------------------------------------------------------
-- A personal workspace stays with its creator
--
-- Personal workspaces may take members (D-30), but only their creator is ever
-- an owner there. o adds ad to o's personal workspace and tries every way of
-- making ad an owner; then ad, as admin, tries to remove or demote o. Without
-- these guards o's personal workspace (where WP-1.2 puts o's documents)
-- could end up belonging to ad.
-- ---------------------------------------------------------------------------

create temp table o_personal as
  select id from public.workspaces
   where is_personal and created_by = '00000000-0000-4000-8000-000000000001';
grant select on o_personal to authenticated, service_role;

select lives_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     values ((select id from o_personal), '00000000-0000-4000-8000-000000000002', 'editor') $$,
  'an owner adds a member to their personal workspace');
with u as (update public.workspace_members set role = 'admin'
            where workspace_id = (select id from o_personal)
              and user_id = '00000000-0000-4000-8000-000000000002' returning 1)
select is(count(*)::int, 1, 'and makes them an admin') from u;
select throws_ok(
  $$ update public.workspace_members set role = 'owner'
      where workspace_id = (select id from o_personal)
        and user_id = '00000000-0000-4000-8000-000000000002' $$,
  '23514', 'only the creator of a personal workspace can be its owner',
  'but not a co-owner (D-30)');
select throws_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     values ((select id from o_personal), '00000000-0000-4000-8000-000000000003', 'owner') $$,
  '42501', null, 'nor add anyone straight in as owner');
select throws_ok(
  $$ delete from public.workspace_members
      where workspace_id = (select id from o_personal)
        and user_id = '00000000-0000-4000-8000-000000000001' $$,
  '23514', 'the owner of a personal workspace cannot leave it or be demoted',
  'the creator cannot leave their personal workspace');
select throws_ok(
  $$ update public.workspace_members set role = 'admin'
      where workspace_id = (select id from o_personal)
        and user_id = '00000000-0000-4000-8000-000000000001' $$,
  '23514', 'the owner of a personal workspace cannot leave it or be demoted',
  'nor step down in it');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*)::int from public.workspaces where id = (select id from o_personal)),
  1, 'a member of a personal workspace reads it');
with d as (delete from public.workspace_members
            where workspace_id = (select id from o_personal)
              and user_id = '00000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 0, 'an admin cannot remove the creator of a personal workspace') from d;
with u as (update public.workspace_members set role = 'viewer'
            where workspace_id = (select id from o_personal)
              and user_id = '00000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 0, 'nor demote them') from u;
select throws_ok(
  $$ update public.workspaces set created_by = null where id = (select id from o_personal) $$,
  '23514', null, 'nor detach the workspace from its creator');

-- The rule holds for writers RLS does not apply to: the service role, and
-- a direct write by the migration role.
reset role;
set local role service_role;
select throws_ok(
  $$ update public.workspace_members set role = 'owner'
      where workspace_id = (select id from o_personal)
        and user_id = '00000000-0000-4000-8000-000000000002' $$,
  '23514', 'only the creator of a personal workspace can be its owner',
  'the service role cannot promote a co-owner in a personal workspace either');
select throws_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     values ((select id from o_personal), '00000000-0000-4000-8000-000000000003', 'owner') $$,
  '23514', 'only the creator of a personal workspace can be its owner',
  'nor insert one');
reset role;
select throws_ok(
  $$ insert into public.workspace_members (workspace_id, user_id, role)
     values ((select id from o_personal), '00000000-0000-4000-8000-000000000003', 'owner')
     on conflict (workspace_id, user_id) do update set role = 'owner' $$,
  '23514', 'only the creator of a personal workspace can be its owner',
  'nor does a direct upsert');
select lives_ok(
  $$ select public.ensure_personal_workspace('00000000-0000-4000-8000-000000000001') $$,
  'ensure_personal_workspace still runs for a personal workspace with members');
select results_eq(
  $$ select user_id, role::text from public.workspace_members
      where workspace_id = (select id from o_personal) order by user_id $$,
  $$ values ('00000000-0000-4000-8000-000000000001'::uuid, 'owner'),
            ('00000000-0000-4000-8000-000000000002'::uuid, 'admin') $$,
  'the creator is still the personal workspace''s only owner');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
with d as (delete from public.workspace_members
            where workspace_id = (select id from o_personal)
              and user_id = '00000000-0000-4000-8000-000000000002' returning 1)
select is(count(*)::int, 1, 'the creator removes the member') from d;

reset role;


-- ---------------------------------------------------------------------------
-- Backfill
--
-- z stands for an account that existed before this migration: their trigger-
-- made workspace is removed. Since WP-1.2 a document cannot exist without a
-- workspace, so z's document is written once the backfill has given them one.
-- ---------------------------------------------------------------------------

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
insert into public.documents (user_id, workspace_id, title, markdown)
values ('00000000-0000-4000-8000-000000000008',
        (select id from public.workspaces
          where is_personal and created_by = '00000000-0000-4000-8000-000000000008'),
        'Legacy note', '# Legacy');
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

-- Repair: a creator who lost their owner row, which only a write with the
-- guard trigger switched off can cause, gets it back.
alter table public.workspace_members disable trigger workspace_members_keep_owner;
update public.workspace_members set role = 'viewer'
 where workspace_id = (select id from public.workspaces where is_personal and created_by = '00000000-0000-4000-8000-000000000008')
   and user_id = '00000000-0000-4000-8000-000000000008';
alter table public.workspace_members enable trigger workspace_members_keep_owner;
select is(
  public.ensure_personal_workspace('00000000-0000-4000-8000-000000000008'),
  (select id from public.workspaces where is_personal and created_by = '00000000-0000-4000-8000-000000000008'),
  'ensure_personal_workspace keeps the workspace of a demoted creator');
select is(
  (select role::text from public.workspace_members
    where workspace_id = (select id from public.workspaces where is_personal and created_by = '00000000-0000-4000-8000-000000000008')
      and user_id = '00000000-0000-4000-8000-000000000008'),
  'owner', 'and makes them its owner again');

alter table public.workspace_members disable trigger workspace_members_keep_owner;
delete from public.workspace_members
 where workspace_id = (select id from public.workspaces where is_personal and created_by = '00000000-0000-4000-8000-000000000008')
   and user_id = '00000000-0000-4000-8000-000000000008';
alter table public.workspace_members enable trigger workspace_members_keep_owner;
select lives_ok(
  $$ select public.ensure_personal_workspace('00000000-0000-4000-8000-000000000008') $$,
  'ensure_personal_workspace runs for a creator with no membership row');
select is(
  (select role::text from public.workspace_members
    where workspace_id = (select id from public.workspaces where is_personal and created_by = '00000000-0000-4000-8000-000000000008')
      and user_id = '00000000-0000-4000-8000-000000000008'),
  'owner', 'and restores their owner membership');

-- Their document is still theirs, through the workspace they own.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000008","role":"authenticated"}';
select is((select count(*)::int from public.documents), 1, 'the legacy account still reads its document');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*)::int from public.documents), 0, 'and nobody else does');
reset role;


-- ---------------------------------------------------------------------------
-- Deleting an account (D-31)
--
-- The roster here is set up by the migration role with explicit joined_at so
-- "longest-standing" is deterministic:
--   acme   owner ad, editor ed, viewer vw (from the sections above)
--   vw's   personal workspace, with ed added as editor
--   beta   owner x; editor ed (earliest), admin n, admin w (latest), and
--          admin o, added by w with a backdated joined_at the server ignores
--   gamma  owners o and x; admin w
--   solo   owner z; editor ed, viewer n
-- ---------------------------------------------------------------------------

insert into public.workspaces (id, name, slug, created_by) values
  ('10000000-0000-4000-8000-000000000002', 'Beta', 'beta', '00000000-0000-4000-8000-000000000005'),
  ('10000000-0000-4000-8000-000000000003', 'Gamma', 'gamma', '00000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000004', 'Solo', 'solo', '00000000-0000-4000-8000-000000000008');
insert into public.workspace_members (workspace_id, user_id, role, joined_at) values
  ((select id from public.workspaces where is_personal and created_by = '00000000-0000-4000-8000-000000000004'),
   '00000000-0000-4000-8000-000000000003', 'editor', now()),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'editor', '2025-01-01'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000007', 'admin',  '2026-01-01'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000006', 'admin',  '2026-02-01'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000005', 'owner',  now()),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000006', 'admin',  now()),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000003', 'editor', now()),
  ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000007', 'viewer', now());
insert into public.documents (user_id, workspace_id, title, markdown) values
  ('00000000-0000-4000-8000-000000000004',
   (select id from public.workspaces where is_personal and created_by = '00000000-0000-4000-8000-000000000004'),
   'Viewer note', '# Mine'),
  ('00000000-0000-4000-8000-000000000003',
   (select id from public.workspaces where is_personal and created_by = '00000000-0000-4000-8000-000000000003'),
   'Editor note', '# Mine');

-- A member of no team workspace as owner: only their personal workspace goes.
create temp table docs_before as select id, user_id, title, markdown from public.documents;
create temp table vw_personal as
  select id from public.workspaces
   where is_personal and created_by = '00000000-0000-4000-8000-000000000004';

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-000000000004' $$,
  'an account that owns only its personal workspace can be deleted');
select is(
  (select count(*)::int from public.workspaces where id = (select id from vw_personal)),
  0, 'its personal workspace is deleted with it');
select is(
  (select count(*)::int from public.workspace_members where workspace_id = (select id from vw_personal)),
  0, 'along with that workspace''s other members');
select is(
  (select count(*)::int from public.workspace_members where user_id = '00000000-0000-4000-8000-000000000004'),
  0, 'its memberships go with it');
select is(
  (select count(*)::int from public.workspace_members where user_id = '00000000-0000-4000-8000-000000000003'),
  4, 'the personal workspace''s other member keeps every other membership, their own personal one included');
select is(
  (select count(*)::int from public.workspaces where id = '10000000-0000-4000-8000-000000000001'),
  1, 'team workspaces it belonged to are untouched');
select is(
  (select count(*)::int from public.documents where user_id = '00000000-0000-4000-8000-000000000004'),
  0, 'its own documents go with its personal workspace');
select set_eq(
  'select id, user_id, title, markdown from public.documents',
  'select * from docs_before where user_id <> ''00000000-0000-4000-8000-000000000004''',
  'every other account''s documents are untouched, the other member''s included');

-- joined_at decides the succession, so no client can choose it. w, beta's
-- latest admin, adds o as an admin backdated to 1960 and tries to backdate
-- themselves; neither moves anyone ahead of n.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';
insert into public.workspace_members (workspace_id, user_id, role, joined_at)
values ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'admin', '1960-01-01');
reset role;
select is(
  (select joined_at from public.workspace_members
    where workspace_id = '10000000-0000-4000-8000-000000000002'
      and user_id = '00000000-0000-4000-8000-000000000001'),
  now(), 'a joined_at sent with a client insert is replaced by now()');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';
select throws_ok(
  $$ update public.workspace_members set joined_at = '1970-01-01'
      where workspace_id = '10000000-0000-4000-8000-000000000002'
        and user_id = '00000000-0000-4000-8000-000000000006' $$,
  '23514', 'a workspace membership''s joined_at cannot change',
  'an admin cannot backdate themselves to the head of the succession');
reset role;
set local role service_role;
select throws_ok(
  $$ update public.workspace_members set joined_at = '1970-01-01'
      where workspace_id = '10000000-0000-4000-8000-000000000002'
        and user_id = '00000000-0000-4000-8000-000000000006' $$,
  '23514', 'a workspace membership''s joined_at cannot change',
  'nor can the service role rewrite it');
reset role;

-- The last owner of a team workspace: the earliest admin takes over.
select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-000000000005' $$,
  'the last owner of a team workspace with an admin can be deleted');
select results_eq(
  $$ select user_id, role::text from public.workspace_members
      where workspace_id = '10000000-0000-4000-8000-000000000002' order by user_id $$,
  $$ values ('00000000-0000-4000-8000-000000000001'::uuid, 'admin'),
            ('00000000-0000-4000-8000-000000000003'::uuid, 'editor'),
            ('00000000-0000-4000-8000-000000000006'::uuid, 'admin'),
            ('00000000-0000-4000-8000-000000000007'::uuid, 'owner') $$,
  'the longest-standing admin becomes owner; a longer-standing editor, a later admin and a backdated one do not');
select results_eq(
  $$ select name, created_by from public.workspaces where id = '10000000-0000-4000-8000-000000000002' $$,
  $$ values ('Beta'::text, null::uuid) $$,
  'the team workspace stays, with created_by cleared');
select results_eq(
  $$ select user_id, role::text from public.workspace_members
      where workspace_id = '10000000-0000-4000-8000-000000000003' order by user_id $$,
  $$ values ('00000000-0000-4000-8000-000000000001'::uuid, 'owner'),
            ('00000000-0000-4000-8000-000000000006'::uuid, 'admin') $$,
  'where another owner remains, nobody is promoted');

-- The last owner of a team workspace with no admin: the deletion is refused.
select throws_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-000000000008' $$,
  '23001',
  'this account is the last owner of workspace "Solo" (10000000-0000-4000-8000-000000000004), which has no admin to take it over',
  'the last owner of a team workspace without an admin cannot be deleted');
select is(
  (select count(*)::int from auth.users where id = '00000000-0000-4000-8000-000000000008'),
  1, 'the account is still there');
select results_eq(
  $$ select user_id, role::text from public.workspace_members
      where workspace_id = '10000000-0000-4000-8000-000000000004' order by user_id $$,
  $$ values ('00000000-0000-4000-8000-000000000003'::uuid, 'editor'),
            ('00000000-0000-4000-8000-000000000007'::uuid, 'viewer'),
            ('00000000-0000-4000-8000-000000000008'::uuid, 'owner') $$,
  'and the workspace''s roster is unchanged; editors and viewers are never promoted');
select is(
  (select count(*)::int from public.workspaces
    where is_personal and created_by = '00000000-0000-4000-8000-000000000008'),
  1, 'its personal workspace is still there');
select is(
  (select count(*)::int from public.documents where user_id = '00000000-0000-4000-8000-000000000008'),
  1, 'and so is its document');

-- Two accounts in one statement: n is beta's owner and, once o is gone
-- again, w its only admin.
delete from public.workspace_members
 where workspace_id = '10000000-0000-4000-8000-000000000002'
   and user_id = '00000000-0000-4000-8000-000000000001';
-- Whichever row goes first, n's trigger promotes w, and then either w's
-- trigger finds no admin left (23001) or, had w's row gone first, the
-- cascade removing w's new owner row trips workspace_members_keep_owner
-- (23514). Either way the whole statement is refused.
select throws_ok(
  $$ delete from auth.users
      where id in ('00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000006') $$,
  null, null,
  'deleting an owner and the admin who would take over at once is refused');
select is(
  (select role::text from public.workspace_members
    where workspace_id = '10000000-0000-4000-8000-000000000002'
      and user_id = '00000000-0000-4000-8000-000000000006'),
  'admin', 'and leaves no half-made promotion behind');

-- Once z hands over, the deletion goes through.
update public.workspace_members set role = 'admin'
 where workspace_id = '10000000-0000-4000-8000-000000000004'
   and user_id = '00000000-0000-4000-8000-000000000003';
select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-000000000008' $$,
  'after an admin is appointed, the last owner can be deleted');
select is(
  (select role::text from public.workspace_members
    where workspace_id = '10000000-0000-4000-8000-000000000004'
      and user_id = '00000000-0000-4000-8000-000000000003'),
  'owner', 'and that admin owns the workspace');


select * from finish();
rollback;
