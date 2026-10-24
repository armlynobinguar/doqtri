-- pgTAP tests for 20261024150000_doc_locks.sql (WP-1.6, D-17).
--
-- Run against a database that has every migration applied and the pgtap
-- extension available, e.g. a Supabase branch or a local stack:
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/doc_locks.test.sql
--
-- Everything runs in one transaction that is rolled back, so now() is one
-- instant throughout: a lock's age is set by moving its heartbeat_at back as
-- the migration role, never by waiting. A user is "signed in" by switching to
-- the authenticated role with their id in the JWT claims.
--
-- Cast:
--   o   owner@example.com     owner of the team workspace "acme"
--   ad  admin@example.com     admin of acme
--   ed  editor@example.com    editor of acme
--   e2  editor2@example.com   editor of acme
--   vw  viewer@example.com    viewer of acme
--   x   outsider@example.com  in no workspace but their own
--   w   a wallet account      editor of acme, named by its address
--
-- Documents:
--   R   "Roadmap" in acme
--   P   "Private" in o's personal workspace, which nobody else is in

begin;
create extension if not exists pgtap with schema extensions;

select plan(70);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'owner@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'admin@example.com'),
  ('00000000-0000-4000-8000-000000000003', 'editor@example.com'),
  ('00000000-0000-4000-8000-000000000004', 'viewer@example.com'),
  ('00000000-0000-4000-8000-000000000005', 'outsider@example.com'),
  ('00000000-0000-4000-8000-000000000006', 'editor2@example.com'),
  ('00000000-0000-4000-8000-000000000007', 'gabcdefghijklmnopqrstuvwxyz234567wxyz@stellar.doqtri.local');

insert into public.workspaces (id, name, slug, created_by) values
  ('10000000-0000-4000-8000-000000000001', 'Acme', 'acme', '00000000-0000-4000-8000-000000000001');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'admin'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'editor'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'viewer'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000006', 'editor'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000007', 'editor');

insert into public.documents (id, user_id, workspace_id, title, markdown) values
  ('30000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000001', 'Roadmap', '# Roadmap'),
  ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
   (select id from public.workspaces
     where is_personal and created_by = '00000000-0000-4000-8000-000000000001'),
   'Private', '# Private');


-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select has_table('public', 'doc_locks', 'doc_locks exists');
select col_not_null('public', 'documents', 'version', 'documents.version is required');
select col_default_is('public', 'documents', 'version', '1', 'and starts at 1');
select ok((select relrowsecurity from pg_class where oid = 'public.doc_locks'::regclass),
  'doc_locks has RLS on');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('take_doc_lock', 'release_doc_lock', 'save_document',
                        'doc_lock_status_for', 'doc_lock_holder_name')
      and p.prosecdef and p.proconfig @> array['search_path=""']),
  5, 'the lock functions are security definer with an empty search_path');
select ok(not has_function_privilege('anon', 'public.take_doc_lock(uuid, boolean)', 'execute'),
  'anon cannot take a lock');
select ok(not has_function_privilege('anon', 'public.save_document(uuid, text, bigint)', 'execute'),
  'anon cannot save');
select ok(not has_function_privilege('authenticated', 'public.doc_lock_holder_name(uuid)', 'execute'),
  'clients cannot look up a holder''s name for an arbitrary user');
select is(
  (select version from public.documents where id = '30000000-0000-4000-8000-000000000010'),
  1::bigint, 'a new document is at version 1');


-- ---------------------------------------------------------------------------
-- Version bookkeeping (any writer)
-- ---------------------------------------------------------------------------

update public.documents set markdown = '# Roadmap, by the server'
 where id = '30000000-0000-4000-8000-000000000001';
select is((select version from public.documents where id = '30000000-0000-4000-8000-000000000001'),
  2::bigint, 'a markdown change by the service side bumps the version');
update public.documents set title = 'Private notes'
 where id = '30000000-0000-4000-8000-000000000001';
select is((select version from public.documents where id = '30000000-0000-4000-8000-000000000001'),
  2::bigint, 'a rename does not');
update public.documents set version = 40
 where id = '30000000-0000-4000-8000-000000000001';
select is((select version from public.documents where id = '30000000-0000-4000-8000-000000000001'),
  2::bigint, 'a version written without a markdown change is put back');


-- ---------------------------------------------------------------------------
-- Taking a lock
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';

select is((select holder from public.doc_lock_status_for('30000000-0000-4000-8000-000000000010')),
  null, 'a document starts unlocked');
select results_eq(
  $$ select mine, holder, holder_name, can_edit, can_take_over, version
       from public.take_doc_lock('30000000-0000-4000-8000-000000000010') $$,
  $$ values (true, '00000000-0000-4000-8000-000000000003'::uuid, 'editor', true, false, 1::bigint) $$,
  'an editor takes a free lock');
select is(
  (select expires_at - heartbeat_at from public.doc_lock_status_for('30000000-0000-4000-8000-000000000010')),
  interval '10 minutes', 'which lasts ten idle minutes');
select throws_ok(
  $$ insert into public.doc_locks (document_id, holder) values
       ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003') $$,
  '42501', null, 'nobody writes doc_locks directly');
select throws_ok(
  $$ update public.doc_locks set heartbeat_at = now() + interval '1 day' $$,
  '42501', null, 'nor stretches a lock');
select throws_ok(
  $$ update public.documents set markdown = 'direct'
      where id = '30000000-0000-4000-8000-000000000010' $$,
  '42501', 'a note''s text is saved through save_document(), which checks the edit lock and version',
  'even the lock holder cannot save with a plain update');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
select results_eq(
  $$ select mine, holder, holder_name, can_edit, can_take_over
       from public.doc_lock_status_for('30000000-0000-4000-8000-000000000010') $$,
  $$ values (false, '00000000-0000-4000-8000-000000000003'::uuid, 'editor', false, false) $$,
  'a viewer sees who is editing');
select is((select count(*)::int from public.doc_locks), 1, 'and reads the lock row');
select throws_ok(
  $$ select public.take_doc_lock('30000000-0000-4000-8000-000000000010') $$,
  '42501', 'you can read this note but not edit it', 'a viewer cannot take a lock');
select throws_ok(
  $$ select public.take_doc_lock('30000000-0000-4000-8000-000000000001') $$,
  'P0002', 'note not found', 'nor one on a note in a workspace they are not in');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
select is((select count(*)::int from public.doc_locks), 0, 'an outsider reads no lock rows');
select throws_ok(
  $$ select public.doc_lock_status_for('30000000-0000-4000-8000-000000000010') $$,
  'P0002', 'note not found', 'nor the status of one');
select throws_ok(
  $$ select public.doc_lock_status_for('30000000-0000-4000-8000-0000000000ff') $$,
  'P0002', 'note not found', 'a missing note looks the same');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';
select results_eq(
  $$ select mine, holder from public.take_doc_lock('30000000-0000-4000-8000-000000000010') $$,
  $$ values (false, '00000000-0000-4000-8000-000000000003'::uuid) $$,
  'a second editor finds the lock held and does not get it');
select throws_ok(
  $$ select public.take_doc_lock('30000000-0000-4000-8000-000000000010', true) $$,
  '42501', 'only an admin of the workspace can take over a note someone is editing',
  'an editor cannot take over');
select is((select release_doc_lock from public.release_doc_lock('30000000-0000-4000-8000-000000000010')),
  false, 'nor release someone else''s lock');
select is((select holder from public.doc_lock_status_for('30000000-0000-4000-8000-000000000010')),
  '00000000-0000-4000-8000-000000000003'::uuid, 'which stays with its holder');


-- ---------------------------------------------------------------------------
-- Renewal and expiry
-- ---------------------------------------------------------------------------

reset role;
update public.doc_locks
   set acquired_at = now() - interval '30 minutes', heartbeat_at = now() - interval '9 minutes'
 where document_id = '30000000-0000-4000-8000-000000000010';

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';
select is((select mine from public.take_doc_lock('30000000-0000-4000-8000-000000000010')),
  false, 'a lock nine minutes idle is still held');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select results_eq(
  $$ select mine, heartbeat_at = now(), acquired_at = now() - interval '30 minutes'
       from public.take_doc_lock('30000000-0000-4000-8000-000000000010') $$,
  $$ values (true, true, true) $$,
  'its holder renews it: heartbeat now, acquired_at kept');

reset role;
update public.doc_locks set heartbeat_at = now() - interval '10 minutes'
 where document_id = '30000000-0000-4000-8000-000000000010';

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
select is((select holder from public.doc_lock_status_for('30000000-0000-4000-8000-000000000010')),
  null, 'after ten idle minutes the lock is free');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';
select results_eq(
  $$ select mine, holder, acquired_at = now()
       from public.take_doc_lock('30000000-0000-4000-8000-000000000010') $$,
  $$ values (true, '00000000-0000-4000-8000-000000000006'::uuid, true) $$,
  'and another editor takes it, from now');

reset role;
update public.doc_locks set heartbeat_at = now() - interval '20 minutes'
 where document_id = '30000000-0000-4000-8000-000000000010';
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';
select results_eq(
  $$ select mine, acquired_at = now() from public.take_doc_lock('30000000-0000-4000-8000-000000000010') $$,
  $$ values (true, true) $$,
  'a holder coming back to a lapsed lock nobody took gets it again, as a new hold');


-- ---------------------------------------------------------------------------
-- Admin takeover
-- ---------------------------------------------------------------------------

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select mine from public.take_doc_lock('30000000-0000-4000-8000-000000000010')),
  false, 'an admin taking a held lock without takeover does not get it');
select results_eq(
  $$ select mine, holder, holder_name, can_take_over
       from public.take_doc_lock('30000000-0000-4000-8000-000000000010', true) $$,
  $$ values (true, '00000000-0000-4000-8000-000000000002'::uuid, 'admin', true) $$,
  'an admin takes it over');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';
select results_eq(
  $$ select mine, holder from public.doc_lock_status_for('30000000-0000-4000-8000-000000000010') $$,
  $$ values (false, '00000000-0000-4000-8000-000000000002'::uuid) $$,
  'the former holder sees that they lost it');
select throws_ok(
  $$ select public.save_document('30000000-0000-4000-8000-000000000010', 'mine now', 1) $$,
  'DQLCK', 'you are not holding the edit lock on this note',
  'and cannot save over the admin');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select mine from public.take_doc_lock('30000000-0000-4000-8000-000000000010', true)),
  true, 'an owner takes over too');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select mine from public.take_doc_lock('30000000-0000-4000-8000-000000000010', true)),
  true, 'and an admin takes it back');


-- ---------------------------------------------------------------------------
-- Release
-- ---------------------------------------------------------------------------

select is((select release_doc_lock from public.release_doc_lock('30000000-0000-4000-8000-000000000010')),
  true, 'the holder releases their lock');
select is((select count(*)::int from public.doc_locks
            where document_id = '30000000-0000-4000-8000-000000000010'),
  0, 'which removes the row');
select is((select release_doc_lock from public.release_doc_lock('30000000-0000-4000-8000-000000000010')),
  false, 'releasing again is a no-op');


-- ---------------------------------------------------------------------------
-- Saving
-- ---------------------------------------------------------------------------

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select public.save_document('30000000-0000-4000-8000-000000000010', '# v2', 1) $$,
  'DQLCK', 'you are not holding the edit lock on this note',
  'an editor without the lock cannot save');
select is((select mine from public.take_doc_lock('30000000-0000-4000-8000-000000000010')),
  true, 'they take it');
select is(public.save_document('30000000-0000-4000-8000-000000000010', '# v2', 1),
  2::bigint, 'and save on the current version, getting the next one');
select results_eq(
  $$ select markdown, version from public.documents where id = '30000000-0000-4000-8000-000000000010' $$,
  $$ values ('# v2', 2::bigint) $$, 'the text and version are stored');
select throws_ok(
  $$ select public.save_document('30000000-0000-4000-8000-000000000010', '# stale', 1) $$,
  'DQVER', 'this note was saved elsewhere since your copy was loaded (version 2 now, yours 1)',
  'a save based on an older version is refused');
select is((select markdown from public.documents where id = '30000000-0000-4000-8000-000000000010'),
  '# v2', 'and overwrites nothing');
select throws_ok(
  $$ select public.save_document('30000000-0000-4000-8000-000000000010', '# ahead', 7) $$,
  'DQVER', null, 'as is one claiming a version that does not exist yet');
select is(public.save_document('30000000-0000-4000-8000-000000000010', '# v2', 2),
  2::bigint, 'saving the stored text again writes nothing');
select is(public.save_document('30000000-0000-4000-8000-000000000010', '# v3', 2),
  3::bigint, 'the next change is version 3');
select throws_ok(
  $$ select public.save_document('30000000-0000-4000-8000-000000000010', null, 3) $$,
  '23502', null, 'null text is refused');

reset role;
update public.doc_locks set heartbeat_at = now() - interval '5 minutes'
 where document_id = '30000000-0000-4000-8000-000000000010';
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(public.save_document('30000000-0000-4000-8000-000000000010', '# v4', 3),
  4::bigint, 'a save on a live lock succeeds');
select is((select heartbeat_at from public.doc_locks
            where document_id = '30000000-0000-4000-8000-000000000010'),
  now(), 'and counts as a heartbeat');

reset role;
update public.doc_locks set heartbeat_at = now() - interval '11 minutes'
 where document_id = '30000000-0000-4000-8000-000000000010';
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok(
  $$ select public.save_document('30000000-0000-4000-8000-000000000010', '# late', 4) $$,
  'DQLCK', null, 'a save on a lapsed lock is refused');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok(
  $$ select public.save_document('30000000-0000-4000-8000-000000000010', 'vandalised', 4) $$,
  '42501', 'you can read this note but not edit it', 'a viewer cannot save');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}';
select throws_ok(
  $$ select public.save_document('30000000-0000-4000-8000-000000000010', 'vandalised', 4) $$,
  'P0002', 'note not found', 'an outsider cannot save');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
with u as (update public.documents set title = 'Roadmap 2027'
            where id = '30000000-0000-4000-8000-000000000010' returning version)
select is((select version from u), 4::bigint, 'an editor still renames with a plain update, version unchanged');


-- ---------------------------------------------------------------------------
-- Wallet accounts are named by their address
-- ---------------------------------------------------------------------------

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000007","role":"authenticated"}';
select is((select holder_name from public.take_doc_lock('30000000-0000-4000-8000-000000000010')),
  'GABC…WXYZ', 'a wallet account is named by its shortened address');


-- ---------------------------------------------------------------------------
-- Removal and demotion drop locks at once (D-16)
-- ---------------------------------------------------------------------------

reset role;
update public.workspace_members set role = 'admin'
 where workspace_id = '10000000-0000-4000-8000-000000000001'
   and user_id = '00000000-0000-4000-8000-000000000007';
select is((select holder from public.doc_locks where document_id = '30000000-0000-4000-8000-000000000010'),
  '00000000-0000-4000-8000-000000000007'::uuid, 'a promotion keeps the lock');
update public.workspace_members set role = 'viewer'
 where workspace_id = '10000000-0000-4000-8000-000000000001'
   and user_id = '00000000-0000-4000-8000-000000000007';
select is((select count(*)::int from public.doc_locks
            where document_id = '30000000-0000-4000-8000-000000000010'),
  0, 'a demotion to viewer drops it');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000006","role":"authenticated"}';
select is((select mine from public.take_doc_lock('30000000-0000-4000-8000-000000000010')),
  true, 'another editor takes it');
-- An admin removes them, through RLS as the app does.
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}';
delete from public.workspace_members
 where workspace_id = '10000000-0000-4000-8000-000000000001'
   and user_id = '00000000-0000-4000-8000-000000000006';
select is((select holder from public.doc_lock_status_for('30000000-0000-4000-8000-000000000010')),
  null, 'removing a member frees their lock at once');

set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is((select mine from public.take_doc_lock('30000000-0000-4000-8000-000000000010')),
  true, 'an editor takes it');
reset role;
delete from auth.users where id = '00000000-0000-4000-8000-000000000003';
select is((select count(*)::int from public.doc_locks), 0, 'deleting the holder''s account frees it');


-- ---------------------------------------------------------------------------
-- Personal workspace with only its owner
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select results_eq(
  $$ select mine, can_edit, can_take_over from public.take_doc_lock('30000000-0000-4000-8000-000000000001') $$,
  $$ values (true, true, true) $$,
  'the owner of a personal workspace takes the lock on their note');
select is(public.save_document('30000000-0000-4000-8000-000000000001', '# Private, edited', 2),
  3::bigint, 'and saves');
select is((select mine from public.take_doc_lock('30000000-0000-4000-8000-000000000001', true)),
  true, 'taking over their own lock is just a renewal');

reset role;
delete from public.documents where id = '30000000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.doc_locks), 0, 'deleting a note deletes its lock');

select * from finish();
rollback;
