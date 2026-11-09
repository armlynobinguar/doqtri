-- pgTAP tests for 20261110100000_documents_created_at.sql (WP-4.7, DOQ-39):
-- documents.created_at exists, is never null, defaults to now() (which
-- gave every pre-existing note the time the migration ran), and a client
-- role can neither choose it on insert nor change it on update, while the
-- service role can.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/documents_created_at.test.sql
--
-- Everything runs in one transaction that is rolled back.

begin;
create extension if not exists pgtap with schema extensions;

select plan(12);

-- ---------------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------------

select has_column('public', 'documents', 'created_at', 'documents has a created_at');
select col_type_is('public', 'documents', 'created_at', 'timestamp with time zone', 'a timestamptz');
select col_not_null('public', 'documents', 'created_at', 'which is never null');
select col_default_is('public', 'documents', 'created_at', 'now()', 'and defaults to now()');
select is((select count(*)::int from public.documents where created_at is null), 0,
  'every existing note has one');

insert into auth.users (id, email) values
  ('60000000-0000-4000-8000-000000000001', 'writer@example.com');

create function pg_temp.personal() returns uuid language sql as $$
  select w.id from public.workspaces w
   where w.is_personal and w.created_by = '60000000-0000-4000-8000-000000000001'
$$;

-- ---------------------------------------------------------------------------
-- The service role writes it; a client role cannot
-- ---------------------------------------------------------------------------

insert into public.documents (id, user_id, workspace_id, title, markdown)
values ('61000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001',
        pg_temp.personal(), 'Server note', '# Server note');
select is((select created_at from public.documents where id = '61000000-0000-4000-8000-000000000001'), now(),
  'a note that names no created_at gets now()');

set local role service_role;
select lives_ok($$
  insert into public.documents (id, user_id, workspace_id, title, markdown, created_at)
  values ('61000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001',
          pg_temp.personal(), 'Restored', '# Restored', '2026-01-01T00:00:00Z')
$$, 'the service role may set created_at (a restore)');
select lives_ok($$
  update public.documents set created_at = '2026-02-01T00:00:00Z'
   where id = '61000000-0000-4000-8000-000000000002'
$$, 'and change it');
reset role;
select is((select created_at from public.documents where id = '61000000-0000-4000-8000-000000000002'),
  '2026-02-01T00:00:00Z'::timestamptz, 'which sticks');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "60000000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
insert into public.documents (id, user_id, workspace_id, title, markdown, created_at)
values ('61000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000001',
        pg_temp.personal(), 'Backdated', '# Backdated', '2020-01-01T00:00:00Z');
select throws_ok($$
  update public.documents set created_at = '2020-01-01T00:00:00Z'
   where id = '61000000-0000-4000-8000-000000000001'
$$, '23514', null, 'a signed-in editor cannot backdate a note');
select lives_ok($$
  update public.documents set updated_at = now()
   where id = '61000000-0000-4000-8000-000000000001'
$$, 'but can still update the rest of the row');
reset role;
select is((select created_at from public.documents where id = '61000000-0000-4000-8000-000000000003'), now(),
  'and an insert by a client role is stamped now(), whatever it sends');

select * from finish();
rollback;
