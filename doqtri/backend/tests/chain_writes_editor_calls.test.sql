-- pgTAP tests for 20261024140000_chain_writes_editor_calls.sql (WP-1.4).
--
-- Run against a database that has every migration applied and the pgtap
-- extension available, e.g. a Supabase branch or a local stack:
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/chain_writes_editor_calls.test.sql
--
-- Everything runs in one transaction that is rolled back. Rows are written
-- as the table owner, as the relay's service role writes them.

begin;
create extension if not exists pgtap with schema extensions;

select plan(13);

insert into auth.users (id, email) values
  ('40000000-0000-4000-8000-000000000001', 'signer@example.com');

insert into public.documents (id, user_id, workspace_id, title, markdown)
select '41000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', w.id, 'Plan', '# Plan'
  from public.workspaces w
 where w.is_personal and w.created_by = '40000000-0000-4000-8000-000000000001';

create function pg_temp.write(p_fn text, p_n int) returns void language sql as $$
  insert into public.chain_writes (network, tx_hash, document_id, fn, owner)
  values ('testnet', lpad(to_hex(p_n), 64, '0'), '41000000-0000-4000-8000-000000000001', p_fn,
          'C' || repeat('A', 55));
$$;

-- The calls the relay indexed before still go in.
select lives_ok($$ select pg_temp.write('register_document', 1) $$, 'register_document is indexed');
select lives_ok($$ select pg_temp.write('update_document', 2) $$, 'update_document is indexed');
select lives_ok($$ select pg_temp.write('set_node_status', 3) $$, 'set_node_status is indexed');
select lives_ok($$ select pg_temp.write('anchor', 4) $$, 'anchor is indexed');

-- The v3 document writes go in too.
select lives_ok($$ select pg_temp.write('anchor_as', 5) $$, 'anchor_as is indexed');
select lives_ok($$ select pg_temp.write('update_document_as', 6) $$, 'update_document_as is indexed');
select lives_ok($$ select pg_temp.write('set_node_status_as', 7) $$, 'set_node_status_as is indexed');
select lives_ok($$ select pg_temp.write('assign_document', 8) $$, 'assign_document is indexed');
select lives_ok($$ select pg_temp.write('unassign_document', 9) $$, 'unassign_document is indexed');

-- Membership calls belong to no document, and nothing else is accepted.
select throws_ok($$ select pg_temp.write('add_editor', 10) $$, '23514', null, 'add_editor is not a document write');
select throws_ok($$ select pg_temp.write('transfer_workspace', 11) $$, '23514', null, 'transfer_workspace is not a document write');
select throws_ok($$ select pg_temp.write('upgrade', 12) $$, '23514', null, 'anything else is refused');

select is((select count(*)::int from public.chain_writes
            where document_id = '41000000-0000-4000-8000-000000000001'), 9,
          'every accepted write is in the index');

select * from finish();
rollback;
