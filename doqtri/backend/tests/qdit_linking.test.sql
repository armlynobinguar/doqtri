-- pgTAP tests for 20261025110000_qdit_linking.sql (WP-2.5).
--
-- Run against a database that has every migration applied and the pgtap
-- extension available, e.g. a Supabase branch or a local stack:
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/qdit_linking.test.sql
--
-- Everything runs in one transaction that is rolled back. A user is "signed
-- in" by switching to the authenticated role with their id in the JWT claims.
-- The integration routes write with the service role; here that is either
-- the service_role role or the test's own superuser, which RLS skips too.
--
-- Cast:
--   o   owner@example.com     owner of the team workspace "acme"
--   ad  admin@example.com     admin of acme
--   ed  editor@example.com    editor of acme
--   vw  viewer@example.com    viewer of acme
--   x   outsider@example.com  in no workspace but their own
--
-- Notes: Plan (acme, linked to qdit project P), Other (acme, not linked).

begin;
create extension if not exists pgtap with schema extensions;

select plan(68);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'owner@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'admin@example.com'),
  ('00000000-0000-4000-8000-000000000003', 'editor@example.com'),
  ('00000000-0000-4000-8000-000000000004', 'viewer@example.com'),
  ('00000000-0000-4000-8000-000000000005', 'outsider@example.com');

insert into public.workspaces (id, name, slug, created_by) values
  ('10000000-0000-4000-8000-000000000001', 'Acme', 'acme', '00000000-0000-4000-8000-000000000001');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'admin'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'editor'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'viewer');

insert into public.documents (id, user_id, workspace_id, title, markdown) values
  ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000001', 'Plan', E'# A\n# B\n# C'),
  ('30000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000001', 'Other', '# Z');


-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select has_table('public', 'doc_project_links', 'doc_project_links exists');
select col_is_pk('public', 'doc_project_links', 'document_id', 'a note links to one project at most (D-09)');
select is(
  (select relrowsecurity from pg_class where oid = 'public.doc_project_links'::regclass),
  true, 'RLS is on for doc_project_links');
select ok(has_table_privilege('authenticated', 'public.doc_project_links', 'select'), 'authenticated may select project links');
select ok(not has_table_privilege('authenticated', 'public.doc_project_links', 'insert'), 'but not insert them');
select ok(not has_table_privilege('authenticated', 'public.doc_project_links', 'update'), 'nor update them');
select ok(not has_table_privilege('authenticated', 'public.doc_project_links', 'delete'), 'nor delete them');
select ok(not has_table_privilege('anon', 'public.doc_project_links', 'select'), 'anon cannot read project links');
select col_default_is('public', 'node_links', 'provider', 'github', 'existing and new rows default to GitHub');
select is(
  (select condeferrable from pg_constraint where conname = 'node_links_document_id_node_id_key'),
  true, 'one link per heading, checked at the end of each statement');

select is(
  (select array_agg(p.prosecdef order by p.proname)
     from pg_proc p
    where p.oid in ('public.apply_node_link_remap(uuid, bigint, jsonb)'::regprocedure,
                    'public.claim_qdit_link_sync(uuid, uuid, integer)'::regprocedure,
                    'public.release_qdit_link_sync(uuid, uuid)'::regprocedure)),
  array[true, true, true], 'the remap and lease functions are security definer');
select is(
  (select count(*)::int
     from pg_proc p
    where p.oid in ('public.apply_node_link_remap(uuid, bigint, jsonb)'::regprocedure,
                    'public.claim_qdit_link_sync(uuid, uuid, integer)'::regprocedure,
                    'public.release_qdit_link_sync(uuid, uuid)'::regprocedure)
      and p.proconfig = array['search_path=""']),
  3, 'and pin an empty search_path');
select ok(not has_function_privilege('authenticated', 'public.apply_node_link_remap(uuid, bigint, jsonb)', 'execute'),
  'authenticated cannot remap links');
select ok(not has_function_privilege('authenticated', 'public.claim_qdit_link_sync(uuid, uuid, integer)', 'execute'),
  'nor take the sync lease');
select ok(not has_function_privilege('authenticated', 'public.release_qdit_link_sync(uuid, uuid)', 'execute'),
  'nor release it');
select ok(has_function_privilege('service_role', 'public.apply_node_link_remap(uuid, bigint, jsonb)', 'execute'),
  'the service role remaps links');


-- ---------------------------------------------------------------------------
-- Rows, as the service role
-- ---------------------------------------------------------------------------

set local role service_role;
select lives_ok(
  $$ insert into public.doc_project_links
       (document_id, project_id, project_name, project_slug, project_url, qdit_link_id, doc_url, linked_by)
     values ('30000000-0000-4000-8000-000000000001', '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34',
             'Soroban payroll', 'soroban-payroll', 'https://qdit.test/projects/soroban-payroll',
             '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', 'https://doqtri.test/vault/30000000-0000-4000-8000-000000000001',
             '00000000-0000-4000-8000-000000000002') $$,
  'the service role links a note to a project');
select throws_ok(
  $$ insert into public.doc_project_links
       (document_id, project_id, project_name, project_slug, qdit_link_id, doc_url)
     values ('30000000-0000-4000-8000-000000000001', '4f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34',
             'Another', 'another', '6a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', 'https://doqtri.test/vault/x') $$,
  '23505', null, 'a second project for the same note is refused (D-09)');

select lives_ok(
  $$ insert into public.node_links (id, user_id, document_id, node_id, node_label, repo, number) values
       ('40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003',
        '30000000-0000-4000-8000-000000000001', 'h0', 'A', 'acme/app', 7) $$,
  'a GitHub link is written as before, without naming a provider');
select lives_ok(
  $$ insert into public.node_links
       (id, user_id, document_id, node_id, node_label, provider,
        qdit_project_id, qdit_milestone_id, qdit_link_id, qdit_state)
     values
       ('40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003',
        '30000000-0000-4000-8000-000000000001', 'h1', 'B', 'qdit',
        '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
        '0e9d4c3b-2a1f-4e5d-8c7b-6a5f4e3d2c11', 'linked'),
       ('40000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000003',
        '30000000-0000-4000-8000-000000000001', 'h2', 'C', 'qdit',
        '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e62',
        '0e9d4c3b-2a1f-4e5d-8c7b-6a5f4e3d2c12', 'linked') $$,
  'qdit links are written for headings of the linked note');
select is(
  (select provider from public.node_links where id = '40000000-0000-4000-8000-000000000001'),
  'github', 'the GitHub row''s provider is github');
select is(
  (select external_ref from public.node_links where id = '40000000-0000-4000-8000-000000000002'),
  '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34/b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
  'a qdit row''s external_ref is <project_id>/<milestone_id>');
select is(
  (select external_ref from public.node_links where id = '40000000-0000-4000-8000-000000000001'),
  null, 'a GitHub row has none');

select throws_ok(
  $$ insert into public.node_links
       (document_id, node_id, provider, qdit_project_id, qdit_milestone_id, qdit_link_id, qdit_state)
     values ('30000000-0000-4000-8000-000000000002', 'h0', 'qdit',
             '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'c81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
             '1e9d4c3b-2a1f-4e5d-8c7b-6a5f4e3d2c1b', 'linked') $$,
  '23503', null, 'a qdit link needs its note linked to that project');
select throws_ok(
  $$ insert into public.node_links
       (document_id, node_id, provider, repo, number, qdit_project_id, qdit_milestone_id, qdit_link_id, qdit_state)
     values ('30000000-0000-4000-8000-000000000001', 'h5', 'qdit', 'acme/app', 1,
             '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'c81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
             '1e9d4c3b-2a1f-4e5d-8c7b-6a5f4e3d2c1b', 'linked') $$,
  '23514', null, 'a qdit row carries no GitHub columns');
select throws_ok(
  $$ insert into public.node_links (document_id, node_id, provider, qdit_project_id)
     values ('30000000-0000-4000-8000-000000000001', 'h5', 'qdit', '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34') $$,
  '23514', null, 'and needs its milestone, link and state');
select throws_ok(
  $$ insert into public.node_links (document_id, node_id, provider) values
       ('30000000-0000-4000-8000-000000000001', 'h5', 'github') $$,
  '23514', null, 'a GitHub row needs its repo and number');
select throws_ok(
  $$ insert into public.node_links
       (document_id, node_id, provider, qdit_project_id, qdit_milestone_id, qdit_link_id, qdit_state)
     values ('30000000-0000-4000-8000-000000000001', 'root', 'qdit',
             '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'c81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
             '1e9d4c3b-2a1f-4e5d-8c7b-6a5f4e3d2c1b', 'linked') $$,
  '23514', null, 'the root node gets no milestone');
select throws_ok(
  $$ insert into public.node_links (document_id, node_id, repo, number) values
       ('30000000-0000-4000-8000-000000000001', 'c3', 'acme/app', 2) $$,
  '23514', null, 'a concept-map node gets no link (D-11)');
select lives_ok(
  $$ insert into public.node_links (id, document_id, node_id, repo, number) values
       ('40000000-0000-4000-8000-000000000009', '30000000-0000-4000-8000-000000000002', 'root', 'acme/app', 3) $$,
  'the root node still takes a GitHub link, as the ship panel always offered');
select throws_ok(
  $$ insert into public.node_links
       (document_id, node_id, provider, qdit_project_id, qdit_milestone_id, qdit_link_id, qdit_state)
     values ('30000000-0000-4000-8000-000000000001', 'h5', 'qdit',
             '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
             '1e9d4c3b-2a1f-4e5d-8c7b-6a5f4e3d2c1b', 'linked') $$,
  '23505', null, 'a milestone links to one heading only (D-06)');
select throws_ok(
  $$ insert into public.node_links (document_id, node_id, repo, number) values
       ('30000000-0000-4000-8000-000000000001', 'h1', 'acme/app', 4) $$,
  '23505', null, 'a heading with a qdit link takes no GitHub link (D-08)');
select throws_ok(
  $$ update public.node_links set qdit_state = 'stale' where id = '40000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'qdit_state is one of the five states');
reset role;


-- ---------------------------------------------------------------------------
-- Signed in
-- ---------------------------------------------------------------------------

-- Viewer
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
select is((select count(*)::int from public.doc_project_links), 1, 'a viewer reads the note''s project link');
select is((select count(*)::int from public.node_links
            where document_id = '30000000-0000-4000-8000-000000000001'),
  3, 'and its GitHub and qdit links');

-- Editor
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select lives_ok(
  $$ insert into public.node_links (id, user_id, document_id, node_id, node_label, repo, number) values
       ('40000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000003',
        '30000000-0000-4000-8000-000000000002', 'h0', 'Z', 'acme/app', 8) $$,
  'an editor still links a heading to GitHub');
select throws_ok(
  $$ insert into public.node_links
       (user_id, document_id, node_id, provider, qdit_project_id, qdit_milestone_id, qdit_link_id, qdit_state)
     values ('00000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001', 'h5', 'qdit',
             '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'c81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
             '1e9d4c3b-2a1f-4e5d-8c7b-6a5f4e3d2c1b', 'linked') $$,
  '42501', null, 'but cannot write a qdit link directly');
with u as (update public.node_links set node_id = 'h7' where id = '40000000-0000-4000-8000-000000000002' returning 1)
select is(count(*)::int, 0, 'nor move one') from u;
with d as (delete from public.node_links where id = '40000000-0000-4000-8000-000000000002' returning 1)
select is(count(*)::int, 0, 'nor delete one') from d;
with u as (update public.node_links set number = 9 where id = '40000000-0000-4000-8000-000000000004' returning 1)
select is(count(*)::int, 1, 'an editor still changes a GitHub link') from u;
select throws_ok(
  $$ update public.node_links
        set provider = 'qdit', repo = null, number = null,
            qdit_project_id = '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34',
            qdit_milestone_id = 'c81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61',
            qdit_link_id = '1e9d4c3b-2a1f-4e5d-8c7b-6a5f4e3d2c1b', qdit_state = 'linked'
      where id = '40000000-0000-4000-8000-000000000004' $$,
  '42501', null, 'but cannot turn it into a qdit link');
with d as (delete from public.node_links where id = '40000000-0000-4000-8000-000000000004' returning 1)
select is(count(*)::int, 1, 'and still removes a GitHub link') from d;
select throws_ok(
  $$ update public.doc_project_links set project_name = 'Renamed' $$,
  '42501', null, 'an editor cannot change the project link');
select throws_ok(
  $$ select public.apply_node_link_remap('30000000-0000-4000-8000-000000000001', 1, '[]') $$,
  '42501', null, 'nor call the remap');

-- Admin: links the note through the route, never directly (D-10, D-48 pattern)
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(
  $$ insert into public.doc_project_links (document_id, project_id, project_name, project_slug, qdit_link_id, doc_url)
     values ('30000000-0000-4000-8000-000000000002', '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34',
             'Forged', 'forged', '7a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', 'https://doqtri.test/vault/y') $$,
  '42501', null, 'an admin cannot write a project link directly either');
select throws_ok(
  $$ delete from public.doc_project_links $$,
  '42501', null, 'nor delete one');

-- Outsider
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
select is((select count(*)::int from public.doc_project_links), 0, 'an outsider sees no project link');
select is((select count(*)::int from public.node_links
            where document_id = '30000000-0000-4000-8000-000000000001'),
  0, 'and no node links');

-- Anon
reset role;
set local role anon;
select throws_ok($$ select count(*) from public.doc_project_links $$, '42501', null, 'anon reads nothing');
reset role;


-- ---------------------------------------------------------------------------
-- apply_node_link_remap
-- ---------------------------------------------------------------------------

set local role service_role;
select is(
  public.apply_node_link_remap('30000000-0000-4000-8000-000000000001', 1,
    '[{"id":"40000000-0000-4000-8000-000000000002","node_id":"h2","qdit_state":"pending"},
      {"id":"40000000-0000-4000-8000-000000000003","node_id":"h1","qdit_state":"pending"}]'),
  2, 'two qdit links swap headings in one call');
select results_eq(
  $$ select node_id, qdit_state from public.node_links
      where id in ('40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000003') order by id $$,
  $$ values ('h2', 'pending'), ('h1', 'pending') $$,
  'each now points at the other''s heading, waiting for qdit');
select is(
  public.apply_node_link_remap('30000000-0000-4000-8000-000000000001', 1,
    '[{"id":"40000000-0000-4000-8000-000000000001","node_id":"h4","node_label":"A2","qdit_state":"pending"}]'),
  1, 'a GitHub link moves and is relabelled');
select results_eq(
  $$ select node_id, node_label, qdit_state from public.node_links where id = '40000000-0000-4000-8000-000000000001' $$,
  $$ values ('h4'::text, 'A2'::text, null::text) $$,
  'and keeps no qdit state');
select throws_ok(
  $$ select public.apply_node_link_remap('30000000-0000-4000-8000-000000000001', 1,
       '[{"id":"40000000-0000-4000-8000-000000000001","node_id":"h1"}]') $$,
  '23505', null, 'a move onto a heading that keeps its link is refused');
select is(
  (select node_id from public.node_links where id = '40000000-0000-4000-8000-000000000001'),
  'h4', 'and changes nothing');
select is(
  public.apply_node_link_remap('30000000-0000-4000-8000-000000000001', 1,
    '[{"id":"40000000-0000-4000-8000-000000000009","node_id":"h3"}]'),
  0, 'a link of another note is not touched');
reset role;
update public.documents set markdown = E'# A\n# B\n# C\n# D' where id = '30000000-0000-4000-8000-000000000001';
set local role service_role;
select is(
  public.apply_node_link_remap('30000000-0000-4000-8000-000000000001', 1,
    '[{"id":"40000000-0000-4000-8000-000000000002","node_id":"h9"}]'),
  null, 'a remap worked out before a later save is dropped');
select is(
  (select node_id from public.node_links where id = '40000000-0000-4000-8000-000000000002'),
  'h2', 'and moves nothing');


-- ---------------------------------------------------------------------------
-- Sync lease
-- ---------------------------------------------------------------------------

select ok(public.claim_qdit_link_sync('30000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  'a free lease is taken');
select ok(not public.claim_qdit_link_sync('30000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'),
  'a second sync finds it taken');
select ok(public.claim_qdit_link_sync('30000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001'),
  'the holder renews it');
select public.release_qdit_link_sync('30000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002');
select ok(not public.claim_qdit_link_sync('30000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'),
  'only the holder releases it');
select public.release_qdit_link_sync('30000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001');
select ok(public.claim_qdit_link_sync('30000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'),
  'once released, the next sync takes it');
update public.doc_project_links set sync_lease_until = now() - interval '1 second'
 where document_id = '30000000-0000-4000-8000-000000000001';
select ok(public.claim_qdit_link_sync('30000000-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000003'),
  'an expired lease is taken over');
select ok(not public.claim_qdit_link_sync('30000000-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003'),
  'a note without a project has no lease to take');


-- ---------------------------------------------------------------------------
-- Unlinking and deleting
-- ---------------------------------------------------------------------------

delete from public.doc_project_links where document_id = '30000000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.node_links
            where document_id = '30000000-0000-4000-8000-000000000001' and provider = 'qdit'),
  0, 'unlinking the project takes the note''s milestone links with it (D-22)');
select is((select count(*)::int from public.node_links
            where document_id = '30000000-0000-4000-8000-000000000001' and provider = 'github'),
  1, 'and leaves its GitHub links');
reset role;

insert into public.doc_project_links (document_id, project_id, project_name, project_slug, qdit_link_id, doc_url)
values ('30000000-0000-4000-8000-000000000002', '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34',
        'Soroban payroll', 'soroban-payroll', '8a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d', 'https://doqtri.test/vault/z');
delete from public.documents where id = '30000000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.doc_project_links
            where document_id = '30000000-0000-4000-8000-000000000002'),
  0, 'deleting a note deletes its project link');

select * from finish();
rollback;
