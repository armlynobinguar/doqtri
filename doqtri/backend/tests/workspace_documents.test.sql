-- pgTAP tests for 20261024130000_workspace_document_ownership.sql (WP-1.2).
--
-- Run against a database that has every migration applied and the pgtap
-- extension available, e.g. a Supabase branch or a local stack:
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/workspace_documents.test.sql
--
-- Everything runs in one transaction that is rolled back. Users are created
-- by inserting into auth.users, which also gives each a personal workspace
-- (WP-1.1). A user is "signed in" by switching to the authenticated role with
-- their id in the JWT claims, which is what auth.uid() reads.
--
-- The backfill section checks specific legacy rows (old-a, old-c: Plan, plan,
-- PLAN, Plan 2) when the database was seeded with them before this migration
-- ran, and skips those checks otherwise; its general checks always run.
--
-- Cast:
--   o  owner@example.com     owner of the team workspace "acme"
--   ad admin@example.com     admin of acme
--   ed editor@example.com    editor of acme
--   vw viewer@example.com    viewer of acme
--   x  outsider@example.com  in no workspace but their own
--   p  anchored@example.com  has an anchored note in their personal workspace

begin;
create extension if not exists pgtap with schema extensions;

select plan(120);

-- A test-only lookup of a user's personal workspace that works under any
-- role, so the tests can name it without being a member.
create schema wp12_test;
grant usage on schema wp12_test to authenticated, anon;
create function wp12_test.personal(p_user uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select w.id from public.workspaces w where w.is_personal and w.created_by = p_user
$$;
grant execute on function wp12_test.personal(uuid) to authenticated, anon;


-- ---------------------------------------------------------------------------
-- Backfill (runs first, before this file adds any document)
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::int from public.documents d
    where d.workspace_id is distinct from wp12_test.personal(d.user_id)),
  0, 'every existing document is in its author''s personal workspace');
select is(
  (select count(*)::int from public.documents d
     join public.workspace_members m
       on m.workspace_id = d.workspace_id and m.user_id = d.user_id and m.role = 'owner'),
  (select count(*)::int from public.documents),
  'and its author owns that workspace, so every document stays reachable for its author');
select is(
  (select count(*)::int from (
     select workspace_id, lower(btrim(title)) from public.documents
      group by 1, 2 having count(*) > 1) dup),
  0, 'no two documents of one workspace share a title');

create table wp12_test.seeded as
  select exists (select 1 from public.documents
                  where id = '21000000-0000-4000-8000-000000000001') as yes;
grant select on wp12_test.seeded to authenticated;

select case when (select yes from wp12_test.seeded) then
  results_eq(
    $$ select id::text, title from public.documents
        where user_id = '20000000-0000-4000-8000-000000000001'
          and id::text like '21000000-%' order by id $$,
    $$ values ('21000000-0000-4000-8000-000000000001', 'Plan'),
              ('21000000-0000-4000-8000-000000000002', 'plan 3'),
              ('21000000-0000-4000-8000-000000000003', 'PLAN 4'),
              ('21000000-0000-4000-8000-000000000004', 'Plan 2') $$,
    'legacy duplicates are renamed with the next free suffix; the oldest keeps its title')
  else skip('database not seeded with legacy documents', 1) end;
select case when (select yes from wp12_test.seeded) then
  is((select title from public.documents where id = '21000000-0000-4000-8000-000000000005'),
     'Plan', 'the same title in another author''s workspace is left alone')
  else skip('database not seeded with legacy documents', 1) end;
select case when (select yes from wp12_test.seeded) then
  is((select markdown from public.documents where id = '21000000-0000-4000-8000-000000000002'),
     '# plan', 'a renamed document keeps its markdown, so its content hash is unchanged')
  else skip('database not seeded with legacy documents', 1) end;
select case when (select yes from wp12_test.seeded) then
  ok(wp12_test.personal('20000000-0000-4000-8000-000000000003') is not null
     and (select workspace_id from public.documents where id = '21000000-0000-4000-8000-000000000005')
         = wp12_test.personal('20000000-0000-4000-8000-000000000003'),
     'an author who had lost their personal workspace gets it back, with their document in it')
  else skip('database not seeded with legacy documents', 1) end;

set local role authenticated;
set local request.jwt.claims to '{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated"}';
select case when (select yes from wp12_test.seeded) then
  is((select count(*)::int from public.documents), 5,
     'a legacy author still reads every one of their documents')
  else skip('database not seeded with legacy documents', 1) end;
select case when (select yes from wp12_test.seeded) then
  is((select count(*)::int from public.node_links), 1, 'and their GitHub links')
  else skip('database not seeded with legacy documents', 1) end;
select case when (select yes from wp12_test.seeded) then
  is((select count(*)::int from public.mindmap_styles), 1, 'and their saved map style')
  else skip('database not seeded with legacy documents', 1) end;
with u as (update public.documents set markdown = '# Old, edited'
            where title = 'Old' and (select yes from wp12_test.seeded) returning 1)
select case when (select yes from wp12_test.seeded) then
  is(count(*)::int, 1, 'and can still edit them')
  else skip('database not seeded with legacy documents', 1) end from u;
set local request.jwt.claims to '{"sub":"20000000-0000-4000-8000-000000000003","role":"authenticated"}';
select case when (select yes from wp12_test.seeded) then
  is((select count(*)::int from public.documents), 1, 'another legacy author reads only their own')
  else skip('database not seeded with legacy documents', 1) end;
reset role;


-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select col_not_null('public', 'documents', 'workspace_id', 'documents.workspace_id is required');
select fk_ok('public', 'documents', 'workspace_id', 'public', 'workspaces', 'id',
  'documents.workspace_id references workspaces');
select is(
  (select confdeltype::text from pg_constraint
    where conrelid = 'public.documents'::regclass and contype = 'f'
      and conkey = array[(select attnum from pg_attribute
                           where attrelid = 'public.documents'::regclass and attname = 'workspace_id')]),
  'r', 'deleting a workspace that still has documents is refused');
select col_is_null('public', 'documents', 'user_id', 'documents.user_id may be null once its author is gone');
select is(
  (select confdeltype::text from pg_constraint where conname = 'documents_user_id_fkey'),
  'n', 'deleting an author clears documents.user_id');
select is(
  (select confdeltype::text from pg_constraint where conname = 'node_links_user_id_fkey'),
  'n', 'deleting an author clears node_links.user_id');
select is(
  (select confdeltype::text from pg_constraint where conname = 'ingests_document_id_fkey'),
  'c', 'deleting a document deletes its import history (D-42)');
select hasnt_index('public', 'documents', 'documents_user_title_idx', 'the per-user title index is gone');
select ok(
  (select indisunique from pg_index where indexrelid = 'public.documents_workspace_title_idx'::regclass),
  'titles are unique per workspace');
select ok(
  (select bool_and(not p.prosecdef and p.proconfig @> array['search_path=""'])
     from pg_proc p
    where p.oid in ('public.documents_before_update()'::regprocedure,
                    'public.documents_before_insert()'::regprocedure,
                    'public.node_links_before_update()'::regprocedure)),
  'the author and public-headings guards run as the writer, with an empty search_path');
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_proc p where p.oid = 'public.handle_deleted_user_workspaces()'::regprocedure),
  'the account deletion trigger function still pins search_path to empty');
select ok(not has_function_privilege('authenticated', 'public.documents_before_update()', 'execute')
          and not has_function_privilege('authenticated', 'public.documents_before_insert()', 'execute'),
  'authenticated cannot call the document guard trigger functions');
select ok(
  (select bool_and(relrowsecurity) from pg_class
    where oid in ('public.documents'::regclass, 'public.node_links'::regclass,
                  'public.mindmap_styles'::regclass)),
  'RLS stays enabled on documents, node_links and mindmap_styles');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename in ('documents', 'node_links')
      and qual like '%auth.uid() = user_id%'),
  0, 'no policy on documents or node_links still grants access by user_id');


-- ---------------------------------------------------------------------------
-- Cast and the team workspace
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'owner@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'admin@example.com'),
  ('00000000-0000-4000-8000-000000000003', 'editor@example.com'),
  ('00000000-0000-4000-8000-000000000004', 'viewer@example.com'),
  ('00000000-0000-4000-8000-000000000005', 'outsider@example.com'),
  ('00000000-0000-4000-8000-000000000006', 'anchored@example.com');

insert into public.workspaces (id, name, slug, created_by) values
  ('10000000-0000-4000-8000-000000000001', 'Acme', 'acme', '00000000-0000-4000-8000-000000000001');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'admin'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'editor'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'viewer');

-- o's own note, in o's personal workspace, which no acme member is in.
insert into public.documents (id, user_id, workspace_id, title, markdown) values
  ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   wp12_test.personal('00000000-0000-4000-8000-000000000001'), 'Private', '# Private');


-- ---------------------------------------------------------------------------
-- Editor
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';

select lives_ok(
  $$ insert into public.documents (id, user_id, workspace_id, title, markdown) values
       ('30000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001', 'Roadmap', '# Roadmap') $$,
  'an editor creates a document in the team workspace');
select throws_ok(
  $$ insert into public.documents (user_id, workspace_id, title) values
       ('00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Forged') $$,
  '42501', null, 'but never in someone else''s name');
select throws_ok(
  $$ insert into public.documents (user_id, title)
     values ('00000000-0000-4000-8000-000000000003', 'Nowhere') $$,
  '42501', null, 'and never without a workspace');
select lives_ok(
  $$ insert into public.documents (id, user_id, workspace_id, title) values
       ('30000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001', 'Scratch') $$,
  'an editor creates a second document');
select is((select count(*)::int from public.documents
            where workspace_id = '10000000-0000-4000-8000-000000000001'),
  2, 'an editor reads the workspace''s documents');
reset role;
-- Scratch's import history: the editor's upload, an admin's re-import, and
-- an unrelated failed import of the editor's.
insert into public.ingests (id, user_id, object_path, filename, kind, status, document_id) values
  ('50000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003',
   'u3/scratch.pdf', 'scratch.pdf', 'pdf', 'succeeded', '30000000-0000-4000-8000-000000000011'),
  ('50000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002',
   'u2/scratch.docx', 'scratch.docx', 'docx', 'succeeded', '30000000-0000-4000-8000-000000000011'),
  ('50000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003',
   'u3/broken.pdf', 'broken.pdf', 'pdf', 'failed', null);
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is((select count(*)::int from public.documents
            where id = '30000000-0000-4000-8000-000000000001'),
  0, 'but not a teammate''s personal ones');
with u as (update public.documents set markdown = '# Roadmap v2'
               where id = '30000000-0000-4000-8000-000000000010' returning 1)
select is(count(*)::int, 1, 'an editor edits a team document') from u;
select throws_ok(
  $$ update public.documents set user_id = '00000000-0000-4000-8000-000000000002'
      where id = '30000000-0000-4000-8000-000000000010' $$,
  '23514', 'a document''s author and workspace cannot be changed',
  'an editor cannot re-attribute a document');
select throws_ok(
  $$ update public.documents set workspace_id = wp12_test.personal('00000000-0000-4000-8000-000000000003')
      where id = '30000000-0000-4000-8000-000000000010' $$,
  '23514', 'a document''s author and workspace cannot be changed',
  'nor move it to another workspace');
with d as (delete from public.documents
               where id = '30000000-0000-4000-8000-000000000011' returning 1)
select is(count(*)::int, 1, 'an editor deletes a team document') from d;
reset role;
select is((select count(*)::int from public.ingests
            where id in ('50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002')),
  0, 'and its import history goes with it, whoever uploaded it (D-42)');
select is((select count(*)::int from public.ingests where id = '50000000-0000-4000-8000-000000000003'),
  1, 'an import that made no note is kept');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';

-- node_links
select lives_ok(
  $$ insert into public.node_links (id, user_id, document_id, node_id, repo, number) values
       ('40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003',
        '30000000-0000-4000-8000-000000000010', 'h0', 'acme/app', 7) $$,
  'an editor links a node of a team document');
select throws_ok(
  $$ insert into public.node_links (user_id, document_id, node_id, repo, number) values
       ('00000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000010', 'h1', 'acme/app', 8) $$,
  '42501', null, 'but never in someone else''s name');
select throws_ok(
  $$ insert into public.node_links (user_id, document_id, node_id, repo, number) values
       ('00000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001', 'h0', 'acme/app', 9) $$,
  '42501', null, 'nor on a document outside their workspaces');
select is((select count(*)::int from public.node_links), 1, 'an editor reads the links');

-- mindmap styles
select lives_ok(
  $$ insert into public.mindmap_styles (user_id, scope, document_id, style) values
       ('00000000-0000-4000-8000-000000000003', 'doc:30000000-0000-4000-8000-000000000010',
        '30000000-0000-4000-8000-000000000010', '{}') $$,
  'an editor saves their own style for a team document''s map');

-- Title uniqueness
select throws_ok(
  $$ insert into public.documents (user_id, workspace_id, title) values
       ('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', ' roadMAP ') $$,
  '23505', null, 'a title already used in the workspace is refused, ignoring case and spaces');
select lives_ok(
  $$ insert into public.documents (id, user_id, workspace_id, title) values
       ('30000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-000000000003',
        wp12_test.personal('00000000-0000-4000-8000-000000000003'), 'Roadmap') $$,
  'the same title is fine in another workspace');
select lives_ok(
  $$ insert into public.documents (id, user_id, workspace_id, title) values
       ('30000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000003',
        '10000000-0000-4000-8000-000000000001', 'Notes') $$,
  'a free title is fine');
select throws_ok(
  $$ update public.documents set title = 'ROADMAP' where id = '30000000-0000-4000-8000-000000000012' $$,
  '23505', null, 'renaming onto a taken title is refused');
select lives_ok(
  $$ update public.documents set title = 'NOTES' where id = '30000000-0000-4000-8000-000000000012' $$,
  'changing only the case of a document''s own title is fine');


-- ---------------------------------------------------------------------------
-- Viewer
-- ---------------------------------------------------------------------------

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';

select is((select count(*)::int from public.documents
            where workspace_id = '10000000-0000-4000-8000-000000000001'),
  2, 'a viewer reads the workspace''s documents');
select is((select markdown from public.documents where id = '30000000-0000-4000-8000-000000000010'),
  '# Roadmap v2', 'with their content');
select throws_ok(
  $$ insert into public.documents (user_id, workspace_id, title) values
       ('00000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', 'Viewer note') $$,
  '42501', null, 'a viewer cannot create a document in the workspace');
with u as (update public.documents set markdown = 'vandalised'
               where id = '30000000-0000-4000-8000-000000000010' returning 1)
select is(count(*)::int, 0, 'a viewer cannot edit one') from u;
with d as (delete from public.documents
               where id = '30000000-0000-4000-8000-000000000010' returning 1)
select is(count(*)::int, 0, 'nor delete one') from d;
select is((select count(*)::int from public.node_links), 1, 'a viewer reads the links');
select throws_ok(
  $$ insert into public.node_links (user_id, document_id, node_id, repo, number) values
       ('00000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000010', 'h2', 'acme/app', 10) $$,
  '42501', null, 'a viewer cannot link a node');
with u as (update public.node_links set number = 99 returning 1)
select is(count(*)::int, 0, 'nor change a link') from u;
with d as (delete from public.node_links returning 1)
select is(count(*)::int, 0, 'nor remove one') from d;
select lives_ok(
  $$ insert into public.mindmap_styles (user_id, scope, document_id, style) values
       ('00000000-0000-4000-8000-000000000004', 'doc:30000000-0000-4000-8000-000000000010',
        '30000000-0000-4000-8000-000000000010', '{}') $$,
  'a viewer saves their own style for a map they can read');
select lives_ok(
  $$ insert into public.documents (user_id, workspace_id, title) values
       ('00000000-0000-4000-8000-000000000004', wp12_test.personal('00000000-0000-4000-8000-000000000004'), 'Mine') $$,
  'a viewer of a team still writes in their own personal workspace');


-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is((select count(*)::int from public.documents
            where workspace_id = '10000000-0000-4000-8000-000000000001'),
  2, 'an admin reads the workspace''s documents');
with u as (update public.documents set markdown = '# Roadmap v3'
               where id = '30000000-0000-4000-8000-000000000010' returning 1)
select is(count(*)::int, 1, 'an admin edits a document an editor wrote') from u;
with u as (update public.node_links set number = 11
               where id = '40000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 1, 'an admin changes a teammate''s link') from u;
select throws_ok(
  $$ update public.node_links set user_id = '00000000-0000-4000-8000-000000000002'
      where id = '40000000-0000-4000-8000-000000000001' $$,
  '23514', 'a node link''s author cannot be changed',
  'but cannot take credit for it');
select lives_ok(
  $$ insert into public.documents (id, user_id, workspace_id, title) values
       ('30000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000001', 'Admin note') $$,
  'an admin creates a document');
with d as (delete from public.documents
               where id = '30000000-0000-4000-8000-000000000013' returning 1)
select is(count(*)::int, 1, 'and deletes one') from d;
select is((select count(*)::int from public.documents
            where id = '30000000-0000-4000-8000-000000000001'),
  0, 'an admin of a team does not see its owner''s personal documents');


-- ---------------------------------------------------------------------------
-- Owner
-- ---------------------------------------------------------------------------

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is((select count(*)::int from public.documents),
  3, 'an owner reads the team''s documents and their own');
with u as (update public.documents set title = 'Roadmap 2027'
               where id = '30000000-0000-4000-8000-000000000010' returning 1)
select is(count(*)::int, 1, 'an owner renames a team document') from u;
select lives_ok(
  $$ insert into public.documents (id, user_id, workspace_id, title) values
       ('30000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001', 'Owner note') $$,
  'an owner creates a document');
with d as (delete from public.node_links
               where id = '40000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 1, 'an owner removes a link an editor made') from d;
select lives_ok(
  $$ insert into public.node_links (id, user_id, document_id, node_id, repo, number) values
       ('40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000010', 'h1', 'acme/app', 12) $$,
  'an owner links a node');
reset role;


-- ---------------------------------------------------------------------------
-- Public headings: admin and above only (D-40)
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ update public.documents set publish_headings = true
      where id = '30000000-0000-4000-8000-000000000010' $$,
  '42501', 'only an admin of the workspace can change whether headings are public',
  'an editor cannot make a team document''s headings public');
select throws_ok(
  $$ insert into public.documents (user_id, workspace_id, title, publish_headings) values
       ('00000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', 'Loud', true) $$,
  '42501', 'only an admin of the workspace can change whether headings are public',
  'nor create one with its headings public');
with u as (update public.documents set markdown = '# Roadmap v2.1', publish_headings = false
               where id = '30000000-0000-4000-8000-000000000010' returning 1)
select is(count(*)::int, 1, 'an editor still edits the other columns, the setting written back unchanged') from u;

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
with u as (update public.documents set publish_headings = true
               where id = '30000000-0000-4000-8000-000000000010' returning 1)
select is(count(*)::int, 1, 'an admin makes a team document''s headings public') from u;

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
with u as (update public.documents set markdown = '# Roadmap v2.2'
               where id = '30000000-0000-4000-8000-000000000010' returning 1)
select is(count(*)::int, 1, 'an editor edits a document whose headings are public') from u;
select throws_ok(
  $$ update public.documents set publish_headings = false
      where id = '30000000-0000-4000-8000-000000000010' $$,
  '42501', 'only an admin of the workspace can change whether headings are public',
  'but cannot hide them again either');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
with u as (update public.documents set publish_headings = false
               where id = '30000000-0000-4000-8000-000000000010' returning 1)
select is(count(*)::int, 1, 'an owner turns it off') from u;
select lives_ok(
  $$ insert into public.documents (id, user_id, workspace_id, title, publish_headings) values
       ('30000000-0000-4000-8000-000000000016', '00000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001', 'Public plan', true) $$,
  'and creates a document with its headings public');
reset role;
select is((select publish_headings from public.documents where id = '30000000-0000-4000-8000-000000000010'),
  false, 'the refused changes left the setting as the owner last set it');
delete from public.documents where id = '30000000-0000-4000-8000-000000000016';


-- ---------------------------------------------------------------------------
-- Outsider
-- ---------------------------------------------------------------------------

-- ed's link again (o removed the first), for the deletion checks below.
insert into public.node_links (id, user_id, document_id, node_id, repo, number) values
  ('40000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003',
   '30000000-0000-4000-8000-000000000010', 'h0', 'acme/app', 7);

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';

select is((select count(*)::int from public.documents), 0, 'an outsider reads no document');
select is((select count(*)::int from public.node_links), 0, 'nor any link');
select throws_ok(
  $$ insert into public.documents (user_id, workspace_id, title) values
       ('00000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', 'Intruder') $$,
  '42501', null, 'an outsider cannot create a document in the workspace');
with u as (update public.documents set markdown = 'x' returning 1)
select is(count(*)::int, 0, 'nor edit one') from u;
with d as (delete from public.documents returning 1)
select is(count(*)::int, 0, 'nor delete one') from d;
select throws_ok(
  $$ insert into public.node_links (user_id, document_id, node_id, repo, number) values
       ('00000000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000010', 'h3', 'acme/app', 1) $$,
  '42501', null, 'nor link one of its nodes');
with d as (delete from public.node_links returning 1)
select is(count(*)::int, 0, 'nor remove a link') from d;
select throws_ok(
  $$ insert into public.mindmap_styles (user_id, scope, document_id, style) values
       ('00000000-0000-4000-8000-000000000005', 'doc:30000000-0000-4000-8000-000000000010',
        '30000000-0000-4000-8000-000000000010', '{}') $$,
  '42501', null, 'nor save a style for a map they cannot read');
select lives_ok(
  $$ insert into public.documents (id, user_id, workspace_id, title) values
       ('30000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000005',
        wp12_test.personal('00000000-0000-4000-8000-000000000005'), 'Outsider note') $$,
  'an outsider writes in their own personal workspace');
select is((select count(*)::int from public.documents), 1, 'and reads only that');

set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select is((select count(*)::int from public.documents), 0, 'signed out, no document is visible');
select is((select count(*)::int from public.node_links), 0, 'nor any link');
reset role;


-- ---------------------------------------------------------------------------
-- Membership changes take effect at once (D-16)
-- ---------------------------------------------------------------------------

update public.workspace_members set role = 'viewer'
 where workspace_id = '10000000-0000-4000-8000-000000000001'
   and user_id = '00000000-0000-4000-8000-000000000003';

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
with u as (update public.documents set markdown = 'late edit'
               where id = '30000000-0000-4000-8000-000000000010' returning 1)
select is(count(*)::int, 0, 'an editor demoted to viewer can no longer edit') from u;
select is((select count(*)::int from public.documents
            where workspace_id = '10000000-0000-4000-8000-000000000001'),
  3, 'but still reads');
reset role;

delete from public.workspace_members
 where workspace_id = '10000000-0000-4000-8000-000000000001'
   and user_id = '00000000-0000-4000-8000-000000000004';

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
select is((select count(*)::int from public.documents
            where workspace_id = '10000000-0000-4000-8000-000000000001'),
  0, 'a removed viewer reads nothing of the workspace');
select is((select count(*)::int from public.node_links), 0, 'nor its links');
select is((select count(*)::int from public.documents), 1, 'and keeps their own personal document');
reset role;

-- A member of someone's personal workspace (D-30) works there by role too.
insert into public.workspace_members (workspace_id, user_id, role) values
  (wp12_test.personal('00000000-0000-4000-8000-000000000001'), '00000000-0000-4000-8000-000000000005', 'editor');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
with u as (update public.documents set markdown = '# Private, shared'
               where id = '30000000-0000-4000-8000-000000000001' returning 1)
select is(count(*)::int, 1, 'an editor added to a personal workspace edits its documents') from u;
select throws_ok(
  $$ update public.documents set publish_headings = true
      where id = '30000000-0000-4000-8000-000000000001' $$,
  '42501', 'only an admin of the workspace can change whether headings are public',
  'but cannot make their headings public: that is the owner''s call');
select lives_ok(
  $$ insert into public.documents (id, user_id, workspace_id, title) values
       ('30000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000005',
        wp12_test.personal('00000000-0000-4000-8000-000000000001'), 'Guest note') $$,
  'and writes new ones there');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
with u as (update public.documents set publish_headings = true
               where id = '30000000-0000-4000-8000-000000000021' returning 1)
select is(count(*)::int, 1, 'the owner of a personal workspace sets it on any document there, a guest''s included') from u;
reset role;


-- ---------------------------------------------------------------------------
-- Workspace deletion
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ delete from public.workspaces where id = '10000000-0000-4000-8000-000000000001' $$,
  '23001', null, 'a workspace that still has documents cannot be deleted');


-- ---------------------------------------------------------------------------
-- Deleting an account
-- ---------------------------------------------------------------------------

-- ed authored the team's Roadmap and a link on it, and a note in their own
-- personal workspace.
select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-000000000003' $$,
  'an author can be deleted');
select results_eq(
  $$ select title, user_id from public.documents where id = '30000000-0000-4000-8000-000000000010' $$,
  $$ values ('Roadmap 2027'::text, null::uuid) $$,
  'a team document they wrote stays with the team, without an author');
select is(
  (select user_id from public.node_links where id = '40000000-0000-4000-8000-000000000003'),
  null, 'so does a link they made');
select is(
  (select count(*)::int from public.documents where id = '30000000-0000-4000-8000-000000000015'),
  0, 'the documents in their personal workspace go with it');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*)::int from public.documents where id = '30000000-0000-4000-8000-000000000010'),
  1, 'teammates still read it');
with u as (update public.documents set markdown = '# Roadmap v4'
               where id = '30000000-0000-4000-8000-000000000010' returning 1)
select is(count(*)::int, 1, 'and edit it') from u;
reset role;

-- o's personal workspace holds o's note and x's guest note (D-39): the guest's
-- note blocks the deletion until it is gone.
select throws_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-000000000001' $$,
  '23001', 'this account''s personal workspace holds 1 note(s) written by other people',
  'an account whose personal workspace holds a guest''s note cannot be deleted');
select is(
  (select count(*)::int from public.documents
    where id in ('30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000021')),
  2, 'and nothing in that workspace was deleted');
select is(
  (select count(*)::int from auth.users where id = '00000000-0000-4000-8000-000000000001'),
  1, 'nor the account');
select is(
  (select role::text from public.workspace_members
    where workspace_id = '10000000-0000-4000-8000-000000000001'
      and user_id = '00000000-0000-4000-8000-000000000002'),
  'admin', 'nor was a team workspace handed over (D-31 waits for the deletion to go ahead)');

-- A note whose author has since deleted their own account has nobody left
-- to lose it, so it does not block.
insert into public.documents (id, user_id, workspace_id, title) values
  ('30000000-0000-4000-8000-000000000022', null,
   wp12_test.personal('00000000-0000-4000-8000-000000000001'), 'Orphan note');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
with d as (delete from public.documents
               where id = '30000000-0000-4000-8000-000000000021' returning 1)
select is(count(*)::int, 1, 'the owner deletes the guest''s note') from d;
reset role;

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-000000000001' $$,
  'then the account can be deleted');
select is(
  (select count(*)::int from public.documents
    where id in ('30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000022')),
  0, 'every document left in their personal workspace goes with it, an orphaned one included');
select is(
  (select role::text from public.workspace_members
    where workspace_id = '10000000-0000-4000-8000-000000000001'
      and user_id = '00000000-0000-4000-8000-000000000002'),
  'owner', 'and the team workspace they last owned passes to its admin (D-31)');
select is(
  (select count(*)::int from public.documents where id = '30000000-0000-4000-8000-000000000014'),
  1, 'their note in the team workspace stays');

-- An anchored note: chain_writes refuses its deletion, so the account stays.
insert into public.documents (id, user_id, workspace_id, title) values
  ('30000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000006',
   wp12_test.personal('00000000-0000-4000-8000-000000000006'), 'Anchored');
insert into public.chain_writes (network, tx_hash, document_id, fn, owner) values
  ('testnet', repeat('a', 64), '30000000-0000-4000-8000-000000000030', 'anchor', 'C' || repeat('A', 55));

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';
select throws_ok(
  $$ delete from public.documents where id = '30000000-0000-4000-8000-000000000030' $$,
  '23001', null, 'an anchored document cannot be deleted, even by its author');
reset role;
select throws_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-000000000006' $$,
  '23001', null, 'nor can an account whose personal workspace holds one');
select is((select count(*)::int from public.documents where id = '30000000-0000-4000-8000-000000000030'),
  1, 'and the document is still there');


select * from finish();
rollback;
