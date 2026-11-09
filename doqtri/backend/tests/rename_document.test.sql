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
--   ad  admin@example.com     admin of acme
--   ed  editor@example.com    editor of acme
--   e2  editor2@example.com   editor of acme
--   vw  viewer@example.com    viewer of acme
--   x   outsider@example.com  in no workspace but their own
--
-- Edit sessions: tab A is a0000000-...-03, the editor's first tab; tab B,
-- b0000000-...-03, is a second tab of the same editor. Others use
-- a0000000-...-<their number>.
--
-- Documents, all in acme:
--   R   "Roadmap", opening with "# Roadmap"
--   C   "Charter"
--   K   "Kick", with CRLF endings and blank lines before its heading

begin;
create extension if not exists pgtap with schema extensions;

select plan(61);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'owner@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'admin@example.com'),
  ('00000000-0000-4000-8000-000000000003', 'editor@example.com'),
  ('00000000-0000-4000-8000-000000000004', 'viewer@example.com'),
  ('00000000-0000-4000-8000-000000000005', 'outsider@example.com'),
  ('00000000-0000-4000-8000-000000000006', 'editor2@example.com');

insert into public.workspaces (id, name, slug, created_by) values
  ('10000000-0000-4000-8000-000000000001', 'Acme', 'acme', '00000000-0000-4000-8000-000000000001');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'admin'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'editor'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'viewer'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000006', 'editor');

insert into public.documents (id, user_id, workspace_id, title, markdown) values
  ('30000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000001', 'Roadmap', E'# Roadmap\n\n## Scope\n'),
  ('30000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000001', 'Charter', E'# Charter\n'),
  ('30000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000001', 'Kick', E'\r\n \t\n# Kick\r\n\r\nBody\r\n');

-- A note as it stands: title, text and version in one row, for "nothing changed" checks.
create function public._t_doc(p_id uuid) returns table (title text, markdown text, version bigint)
language sql stable security definer set search_path = '' as $$
  select d.title, d.markdown, d.version from public.documents d where d.id = p_id
$$;
grant execute on function public._t_doc(uuid) to authenticated;


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
select ok(not has_function_privilege('authenticated', 'public.title_heading_rewrite(text, text)', 'execute'),
  'the heading helper is internal');


-- ---------------------------------------------------------------------------
-- title_heading_rewrite(): only the first non-blank line, every other byte kept
-- ---------------------------------------------------------------------------

select is(public.title_heading_rewrite(E'# Old\n\n## Scope\n', '  New  '),
  E'# New\n\n## Scope\n', 'the first line becomes # <trimmed title>');
select is(public.title_heading_rewrite(E'# Old\r\nBody\r\n', 'New'),
  E'# New\r\nBody\r\n', 'a CRLF ending stays CRLF');
select is(public.title_heading_rewrite(E'\n \t\r\n# Old #\nBody', 'New'),
  E'\n \t\r\n# New\nBody', 'blank lines before it are kept as they are');
select is(public.title_heading_rewrite(E'\n  \n', 'New'), null, 'a note of blank lines has no line to rewrite');


-- ---------------------------------------------------------------------------
-- Lock free
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';

select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan', E'# Plan\n\n## Scope\n', 1, null),
  2::bigint, 'with the lock free, an editor renames the title and the heading; the version goes up');
select results_eq(
  $$ select * from public._t_doc('30000000-0000-4000-8000-000000000010') $$,
  $$ values ('Plan'::text, E'# Plan\n\n## Scope\n'::text, 2::bigint) $$,
  'both written in one go');
select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan B', null, 2, null),
  2::bigint, 'a title-only rename leaves the version alone');
select results_eq(
  $$ select * from public._t_doc('30000000-0000-4000-8000-000000000010') $$,
  $$ values ('Plan B'::text, E'# Plan\n\n## Scope\n'::text, 2::bigint) $$,
  'and the text');


-- ---------------------------------------------------------------------------
-- The text may change only in its title heading
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan C',
       E'# Plan C\n\n## Hacked\n', 2, null) $$,
  '22023', 'markdown may only change the title heading', 'arbitrary text is refused');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan C',
       E'# Something else\n\n## Scope\n', 2, null) $$,
  '22023', 'markdown may only change the title heading', 'so is a heading that is not the new title');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan C',
       E'# Plan C\n\n## Scope\n', null, null) $$,
  '22023', 'a rename that changes the text needs the version it was read at',
  'text without the version it was read at is refused');
select results_eq(
  $$ select * from public._t_doc('30000000-0000-4000-8000-000000000010') $$,
  $$ values ('Plan B'::text, E'# Plan\n\n## Scope\n'::text, 2::bigint) $$,
  'none of them wrote anything');

select is(
  public.rename_document('30000000-0000-4000-8000-000000000012', 'Kickoff',
    E'\r\n \t\n# Kickoff\r\n\r\nBody\r\n', 1, null),
  2::bigint, 'a heading after blank lines, with CRLF endings, is renamed');
select results_eq(
  $$ select * from public._t_doc('30000000-0000-4000-8000-000000000012') $$,
  $$ values ('Kickoff'::text, E'\r\n \t\n# Kickoff\r\n\r\nBody\r\n'::text, 2::bigint) $$,
  'every other byte as it was');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000012', 'Kickoff 2',
       E'\r\n \t\n# Kickoff 2\n\r\nBody\r\n', 2, null) $$,
  '22023', 'markdown may only change the title heading', 'dropping the heading''s CRLF is refused');


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
  $$ select * from public._t_doc('30000000-0000-4000-8000-000000000010') $$,
  $$ values ('Plan C'::text, E'# Plan C\n\n## Scope\n'::text, 3::bigint) $$,
  'title and text written');
reset role;
select is((select heartbeat_at from public.doc_locks where document_id = '30000000-0000-4000-8000-000000000010'),
  now(), 'and the lock''s heartbeat is renewed, as a save renews it');
update public.doc_locks set heartbeat_at = now() - interval '5 minutes'
 where document_id = '30000000-0000-4000-8000-000000000010';
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan C2', null, 3,
    'a0000000-0000-4000-8000-000000000003'),
  3::bigint, 'tab A renames the title only');
reset role;
select is((select heartbeat_at from public.doc_locks where document_id = '30000000-0000-4000-8000-000000000010'),
  now(), 'which renews the heartbeat too');


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
  $$ select * from public._t_doc('30000000-0000-4000-8000-000000000010') $$,
  $$ values ('Plan C2'::text, E'# Plan C\n\n## Scope\n'::text, 3::bigint) $$,
  'neither changed anything');
select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan D', null, 3,
    'b0000000-0000-4000-8000-000000000003'),
  3::bigint, 'a title-only rename from tab B goes on, as before');
select results_eq(
  $$ select * from public._t_doc('30000000-0000-4000-8000-000000000010') $$,
  $$ values ('Plan D'::text, E'# Plan C\n\n## Scope\n'::text, 3::bigint) $$,
  'changing the title only');
select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan E', null, null, null),
  3::bigint, 'and one that names no session');


-- ---------------------------------------------------------------------------
-- The caller's own lapsed lock, from another session
-- ---------------------------------------------------------------------------

reset role;
update public.doc_locks set heartbeat_at = now() - interval '11 minutes'
 where document_id = '30000000-0000-4000-8000-000000000010';
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan F',
    E'# Plan F\n\n## Scope\n', 3, 'b0000000-0000-4000-8000-000000000003'),
  4::bigint, 'tab A''s lapsed lock counts as free: tab B rewrites the heading');
reset role;
select is((select heartbeat_at from public.doc_locks where document_id = '30000000-0000-4000-8000-000000000010'),
  now() - interval '11 minutes', 'and the lapsed lock is not renewed for a session that does not hold it');


-- ---------------------------------------------------------------------------
-- Stale version
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan G',
       E'# Plan G\n\n## Scope\n', 3, null) $$,
  'DQVER', null, 'a heading rewritten from an older version is refused');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Plan G', null, 3, null) $$,
  'DQVER', null, 'so is a title-only rename that names an older version');
select results_eq(
  $$ select * from public._t_doc('30000000-0000-4000-8000-000000000010') $$,
  $$ values ('Plan F'::text, E'# Plan F\n\n## Scope\n'::text, 4::bigint) $$,
  'writing nothing');


-- ---------------------------------------------------------------------------
-- Title another note has
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Charter',
       E'# Charter\n\n## Scope\n', 4, null) $$,
  '23505', null, 'a title another note in the workspace has is refused');
select results_eq(
  $$ select * from public._t_doc('30000000-0000-4000-8000-000000000010') $$,
  $$ values ('Plan F'::text, E'# Plan F\n\n## Scope\n'::text, 4::bigint) $$,
  'and neither the title nor the text changed');


-- ---------------------------------------------------------------------------
-- Titles are one line: U+0001-U+001F and U+007F are refused, as in lib/title.ts
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', E'New\n## Injected', null, 4, null) $$,
  '23514', 'a note''s title is one line of text', 'a title with a line break is refused');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', '  ', null, 4, null) $$,
  '23514', 'a note''s title is one line of text', 'so is a blank one');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', E'Tab\there', null, 4, null) $$,
  '23514', 'a note''s title is one line of text', 'and one with a tab');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', E'Del\x7f', null, 4, null) $$,
  '23514', 'a note''s title is one line of text', 'and one with DEL');
select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', E'Next\u0085Line', null, 4, null),
  4::bigint, 'U+0085 is not in the class, as in lib/title.ts, and is allowed');


-- ---------------------------------------------------------------------------
-- No direct title change by a client
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ update public.documents set title = 'Direct' where id = '30000000-0000-4000-8000-000000000010' $$,
  '42501', 'a note''s title is changed through rename_document(), which checks the edit lock',
  'an editor cannot change a title with a plain update');
select throws_ok(
  $$ update public.documents set title = E'A\n# B' where id = '30000000-0000-4000-8000-000000000010' $$,
  '42501', 'a note''s title is changed through rename_document(), which checks the edit lock',
  'nor slip a heading in that way');
with u as (update public.documents set mindmap_hash = 'stale'
            where id = '30000000-0000-4000-8000-000000000010' returning 1)
select is(count(*)::int, 1, 'other columns are still written under the editor policy') from u;


-- ---------------------------------------------------------------------------
-- Held by another user
-- ---------------------------------------------------------------------------

select is((select mine from public.take_doc_lock('30000000-0000-4000-8000-000000000010',
  'a0000000-0000-4000-8000-000000000003')), true, 'the editor holds the lock again');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Theirs',
       E'# Theirs\n\n## Scope\n', 4, 'a0000000-0000-4000-8000-000000000006') $$,
  'DQLCK', 'someone else is editing this note',
  'another editor cannot rewrite the heading while the note is locked');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Theirs', null, 4, null) $$,
  'DQLCK', 'someone else is editing this note',
  'nor rename it at all');
select results_eq(
  $$ select title, version from public._t_doc('30000000-0000-4000-8000-000000000010') $$,
  $$ values (E'Next\u0085Line'::text, 4::bigint) $$,
  'nothing changed');

reset role;
update public.doc_locks set heartbeat_at = now() - interval '11 minutes'
 where document_id = '30000000-0000-4000-8000-000000000010';
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';
select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Theirs',
    E'# Theirs\n\n## Scope\n', 4, 'a0000000-0000-4000-8000-000000000006'),
  5::bigint, 'another user''s lapsed lock counts as free');
reset role;
select is((select heartbeat_at from public.doc_locks where document_id = '30000000-0000-4000-8000-000000000010'),
  now() - interval '11 minutes', 'and is not renewed for someone who does not hold it');


-- ---------------------------------------------------------------------------
-- Owner and admin
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Owner title', null, 5, null),
  5::bigint, 'the workspace owner renames');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(
  public.rename_document('30000000-0000-4000-8000-000000000010', 'Admin title',
    E'# Admin title\n\n## Scope\n', 5, 'a0000000-0000-4000-8000-000000000002'),
  6::bigint, 'an admin renames with the heading');


-- ---------------------------------------------------------------------------
-- Viewers, outsiders, missing notes
-- ---------------------------------------------------------------------------

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Viewer', null, 6, null) $$,
  '42501', 'you can read this note but not rename it', 'a viewer cannot rename');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Viewer',
       E'# Viewer\n\n## Scope\n', 6, null) $$,
  '42501', 'you can read this note but not rename it', 'nor rewrite the heading');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Outsider', null, 6, null) $$,
  'P0002', 'note not found', 'an outsider is told the note does not exist');
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-0000000000ff', 'Missing', null, null, null) $$,
  'P0002', 'note not found', 'as for a missing note');

reset role;
set local request.jwt.claims to '{}';
select throws_ok(
  $$ select public.rename_document('30000000-0000-4000-8000-000000000010', 'Nobody', null, 6, null) $$,
  'P0002', 'note not found', 'and for a caller with no user');
select results_eq(
  $$ select * from public._t_doc('30000000-0000-4000-8000-000000000010') $$,
  $$ values ('Admin title'::text, E'# Admin title\n\n## Scope\n'::text, 6::bigint) $$,
  'none of them changed the note');

select * from finish();
rollback;
