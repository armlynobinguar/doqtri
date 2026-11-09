-- pgTAP tests for 20261109100000_rename_document.sql (DOQ-35, WP-1.7).
--
-- Run against a database that has every migration applied and the pgtap
-- extension available, e.g. a Supabase branch or a local stack:
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/rename_document.test.sql
--
-- One transaction, rolled back: now() is fixed, so a lock's age is set by
-- moving its heartbeat_at back as the migration role. A user is "signed in"
-- by switching to the authenticated role with their id in the JWT claims.
--
-- Cast:
--   o   owner@example.com     owner of the team workspace "acme"
--   ed  editor@example.com    editor of acme
--   e2  editor2@example.com   editor of acme
--   vw  viewer@example.com    viewer of acme
--   x   outsider@example.com  in no workspace but their own
--
-- Edit sessions: tab A is a0000000-...-03, the editor's first tab; tab B,
-- b0000000-...-03, is a second tab of the same editor.
--
-- Documents, both in acme:
--   R   "Roadmap", opening with "# Roadmap"
--   C   "Charter"

begin;
create extension if not exists pgtap with schema extensions;

select plan(36);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'owner@example.com'),
  ('00000000-0000-4000-8000-000000000003', 'editor@example.com'),
  ('00000000-0000-4000-8000-000000000004', 'viewer@example.com'),
  ('00000000-0000-4000-8000-000000000005', 'outsider@example.com'),
  ('00000000-0000-4000-8000-000000000006', 'editor2@example.com');

insert into public.workspaces (id, name, slug, created_by) values
  ('10000000-0000-4000-8000-000000000001', 'Acme', 'acme', '00000000-0000-4000-8000-000000000001');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'editor'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'viewer'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000006', 'editor');

insert into public.documents (id, user_id, workspace_id, title, markdown) values
  ('30000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000001', 'Roadmap', E'# Roadmap\n\n## Scope\n'),
  ('30000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000001', 'Charter', E'# Charter\n');

-- The note as it stands: title, text and version in one row, for "nothing changed" checks.
create function public._t_roadmap() returns table (title text, markdown text, version bigint)
language sql stable security definer set search_path = '' as $$
  select d.title, d.markdown, d.version from public.documents d
   where d.id = '30000000-0000-4000-8000-000000000010'
$$;
grant execute on function public._t_roadmap() to authenticated;


-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select is(
  (select p.prosecdef from pg_proc p
    where p.oid = 'public.rename_document(uuid, text, text, bigint, uuid)'::regprocedure),
  true, 'rename_document() is security definer');
select is(
  (select p.proconfig from pg_proc p
    where p.oid = 'public.rename_document(uuid, text, text, bigint, uuid)'::regprocedure),
  array['search_path=""'], 'with an empty search_path');
select ok(not has_function_privilege('anon', 'public.rename_document(uuid, text, text, bigint, uuid)', 'execute'),
  'anon cannot rename');
select ok(has_function_privilege('authenticated', 'public.rename_document(uuid, text, text, bigint, uuid)', 'execute'),
  'a signed-in user can call it');


-- ---------------------------------------------------------------------------
-- Lock free
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';

select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan',
    E'# Plan\n\n## Scope\n', 1, null),
  2::bigint, 'with the lock free, an editor renames the title and the heading; the version goes up');
select results_eq(
  $$ select * from public._t_roadmap() $$,
  $$ values ('Plan'::text, E'# Plan\n\n## Scope\n'::text, 2::bigint) $$,
  'both written in one go');
select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan B', null, 2, null),
  2::bigint, 'a title-only rename leaves the version alone');
select results_eq(
  $$ select * from public._t_roadmap() $$,
  $$ values ('Plan B'::text, E'# Plan\n\n## Scope\n'::text, 2::bigint) $$,
  'and the text');


-- ---------------------------------------------------------------------------
-- Held by the caller, from the session that asks
-- ---------------------------------------------------------------------------

select is((select mine from public.take_doc_lock('30000000-0000-4000-8000-000000000010',
  'a0000000-0000-4000-8000-000000000003')), true, 'the editor takes the lock in tab A');
reset role;
update public.doc_locks set heartbeat_at = now() - interval '5 minutes'
 where document_id = '30000000-0000-4000-8000-000000000010';
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';

select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan C',
    E'# Plan C\n\n## Scope\n', 2, 'a0000000-0000-4000-8000-000000000003'),
  3::bigint, 'tab A renames with the heading');
select results_eq(
  $$ select * from public._t_roadmap() $$,
  $$ values ('Plan C'::text, E'# Plan C\n\n## Scope\n'::text, 3::bigint) $$,
  'title and text written');
reset role;
select is((select heartbeat_at from public.doc_locks where document_id = '30000000-0000-4000-8000-000000000010'),
  now(), 'and the lock''s heartbeat is renewed, as a save renews it');


-- ---------------------------------------------------------------------------
-- Held by the caller, from another session
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';

select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan D',
       E'# Plan D\n\n## Scope\n', 3, 'b0000000-0000-4000-8000-000000000003') $$,
  'DQLCK', 'you are editing this note in another tab or window',
  'tab B cannot rewrite the heading while tab A holds the lock');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan D',
       E'# Plan D\n\n## Scope\n', 3, null) $$,
  'DQLCK', 'you are editing this note in another tab or window',
  'nor can a rename that names no session (the explorer)');
select results_eq(
  $$ select * from public._t_roadmap() $$,
  $$ values ('Plan C'::text, E'# Plan C\n\n## Scope\n'::text, 3::bigint) $$,
  'neither changed anything');
select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan D', null, 3,
    'b0000000-0000-4000-8000-000000000003'),
  3::bigint, 'a title-only rename from tab B goes on, as before');
select results_eq(
  $$ select * from public._t_roadmap() $$,
  $$ values ('Plan D'::text, E'# Plan C\n\n## Scope\n'::text, 3::bigint) $$,
  'changing the title only');
select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan E', null, null, null),
  3::bigint, 'and one that names no session');


-- ---------------------------------------------------------------------------
-- Stale version
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan F',
       E'# Plan F\n\n## Scope\n', 2, 'a0000000-0000-4000-8000-000000000003') $$,
  'DQVER', null, 'a heading rewritten from an older version is refused');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan F', null, 2,
       'a0000000-0000-4000-8000-000000000003') $$,
  'DQVER', null, 'so is a title-only rename that names an older version');
select results_eq(
  $$ select * from public._t_roadmap() $$,
  $$ values ('Plan E'::text, E'# Plan C\n\n## Scope\n'::text, 3::bigint) $$,
  'writing nothing');


-- ---------------------------------------------------------------------------
-- Title another note has
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Charter',
       E'# Charter\n\n## Scope\n', 3, 'a0000000-0000-4000-8000-000000000003') $$,
  '23505', null, 'a title another note in the workspace has is refused');
select results_eq(
  $$ select * from public._t_roadmap() $$,
  $$ values ('Plan E'::text, E'# Plan C\n\n## Scope\n'::text, 3::bigint) $$,
  'and neither the title nor the text changed');


-- ---------------------------------------------------------------------------
-- Titles that are not one line
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', E'New\n## Injected', null, 3, null) $$,
  '23514', 'a note''s title is one line of text', 'a title with a line break is refused');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', '  ', null, 3, null) $$,
  '23514', 'a note''s title is one line of text', 'so is a blank one');


-- ---------------------------------------------------------------------------
-- Held by another user
-- ---------------------------------------------------------------------------

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';

select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Theirs',
       E'# Theirs\n\n## Scope\n', 3, 'a0000000-0000-4000-8000-000000000006') $$,
  'DQLCK', 'someone else is editing this note',
  'another editor cannot rewrite the heading while the note is locked');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Theirs', null, 3, null) $$,
  'DQLCK', 'someone else is editing this note',
  'nor rename it at all');
select results_eq(
  $$ select * from public._t_roadmap() $$,
  $$ values ('Plan E'::text, E'# Plan C\n\n## Scope\n'::text, 3::bigint) $$,
  'nothing changed');

reset role;
update public.doc_locks set heartbeat_at = now() - interval '11 minutes'
 where document_id = '30000000-0000-4000-8000-000000000010';
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';
select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Theirs',
    E'# Theirs\n\n## Scope\n', 3, 'a0000000-0000-4000-8000-000000000006'),
  4::bigint, 'a lapsed lock counts as free');
reset role;
select is((select heartbeat_at from public.doc_locks where document_id = '30000000-0000-4000-8000-000000000010'),
  now() - interval '11 minutes', 'and is not renewed for someone who does not hold it');


-- ---------------------------------------------------------------------------
-- Viewers, outsiders, missing notes
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Viewer', null, 4, null) $$,
  '42501', 'you can read this note but not rename it', 'a viewer cannot rename');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Viewer',
       E'# Viewer\n\n## Scope\n', 4, null) $$,
  '42501', 'you can read this note but not rename it', 'nor rewrite the heading');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Outsider', null, 4, null) $$,
  'P0002', 'note not found', 'an outsider is told the note does not exist');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-0000000000ff', 'Missing', null, null, null) $$,
  'P0002', 'note not found', 'as for a missing note');

reset role;
set local request.jwt.claims to '{}';
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Nobody', null, 4, null) $$,
  'P0002', 'note not found', 'and for a caller with no user');
select results_eq(
  $$ select * from public._t_roadmap() $$,
  $$ values ('Theirs'::text, E'# Theirs\n\n## Scope\n'::text, 4::bigint) $$,
  'none of them changed the note');

select * from finish();
rollback;
