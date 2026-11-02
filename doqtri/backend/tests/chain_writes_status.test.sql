-- pgTAP tests for 20261101110000_chain_writes_status.sql (WP-4.1, DOQ-5):
-- chain_writes.status backfills and defaults to confirmed, takes only
-- pending | confirmed | failed, is readable by everyone like the rest of the
-- row and writable by the service role only, and a note whose write failed
-- can be deleted while a pending or confirmed write still keeps its note.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/chain_writes_status.test.sql
--
-- Everything runs in one transaction that is rolled back. Rows are written
-- as the table owner unless a role is set, as the relay's service role
-- writes them. The backfill check holds for whatever rows the database had
-- when the migration ran: run against a copy of production, or with rows
-- inserted before the migration, it checks them all.

begin;
create extension if not exists pgtap with schema extensions;

select plan(27);

-- ---------------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------------

select has_column('public', 'chain_writes', 'status', 'chain_writes has a status');
select col_not_null('public', 'chain_writes', 'status', 'which is never null');
select col_default_is('public', 'chain_writes', 'status', 'confirmed', 'and defaults to confirmed');
select is((select count(*)::int from public.chain_writes where status <> 'confirmed'), 0,
  'every row written before the migration is backfilled as confirmed');
select ok((select relrowsecurity from pg_class where oid = 'public.chain_writes'::regclass),
  'row level security is still on');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'chain_writes_pending_idx'),
  'the pending rows have an index for the chain-jobs run');

insert into auth.users (id, email) values
  ('50000000-0000-4000-8000-000000000001', 'writer@example.com');

insert into public.documents (id, user_id, workspace_id, title, markdown)
select v.id::uuid, '50000000-0000-4000-8000-000000000001', w.id, v.title, '# ' || v.title
  from public.workspaces w,
       (values ('51000000-0000-4000-8000-000000000001', 'Confirmed'),
               ('51000000-0000-4000-8000-000000000002', 'Pending'),
               ('51000000-0000-4000-8000-000000000003', 'Failed'),
               ('51000000-0000-4000-8000-000000000004', 'Refused')) as v(id, title)
 where w.is_personal and w.created_by = '50000000-0000-4000-8000-000000000001';

create function pg_temp.write(p_doc int, p_n int, p_status text default null) returns void language plpgsql as $$
begin
  if p_status is null then
    insert into public.chain_writes (network, tx_hash, document_id, fn, owner)
    values ('testnet', lpad(to_hex(p_n), 64, '0'), ('51000000-0000-4000-8000-00000000000' || p_doc)::uuid,
            'anchor', 'C' || repeat('A', 55));
  else
    insert into public.chain_writes (network, tx_hash, document_id, fn, owner, status)
    values ('testnet', lpad(to_hex(p_n), 64, '0'), ('51000000-0000-4000-8000-00000000000' || p_doc)::uuid,
            'anchor', 'C' || repeat('A', 55), p_status);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The check constraint
-- ---------------------------------------------------------------------------

select lives_ok($$ select pg_temp.write(1, 1) $$, 'a write that names no status goes in (the sponsored path)');
select is((select status from public.chain_writes where tx_hash = lpad(to_hex(1), 64, '0')), 'confirmed',
  'as confirmed');
select lives_ok($$ select pg_temp.write(2, 2, 'pending') $$, 'a pending write goes in');
select lives_ok($$ select pg_temp.write(3, 3, 'failed') $$, 'a failed write goes in');
select throws_ok($$ select pg_temp.write(4, 4, 'landed') $$, '23514', null, 'any other status is refused');
select throws_ok($$ update public.chain_writes set status = null where tx_hash = lpad(to_hex(1), 64, '0') $$,
  '23502', null, 'and so is no status');
select throws_ok($$ insert into public.chain_writes (network, tx_hash, document_id, fn, owner, status)
                    values ('testnet', lpad(to_hex(5), 64, '0'), '51000000-0000-4000-8000-000000000004',
                            'add_editor', 'C' || repeat('A', 55), 'pending') $$,
  '23514', null, 'the fn check still holds');

-- ---------------------------------------------------------------------------
-- RLS: everyone reads, only the service role writes
-- ---------------------------------------------------------------------------

set local role anon;
select is((select array_agg(status order by tx_hash) from public.chain_writes),
  array['confirmed', 'pending', 'failed'], 'anon reads every row with its status (the public audit page)');
select throws_ok($$ select pg_temp.write(4, 6, 'confirmed') $$, '42501', null, 'anon cannot insert');
update public.chain_writes set status = 'confirmed' where status = 'pending';
delete from public.chain_writes;
reset role;
select is((select count(*)::int from public.chain_writes where status = 'pending'), 1,
  'nor mark a pending write confirmed');
select is((select count(*)::int from public.chain_writes), 3, 'nor delete any');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "50000000-0000-4000-8000-000000000001", "role": "authenticated"}', true);
select is((select count(*)::int from public.chain_writes), 3, 'a signed-in user reads every row too');
select throws_ok($$ select pg_temp.write(4, 7, 'confirmed') $$, '42501', null, 'but cannot insert, even for their own note');
update public.chain_writes set status = 'confirmed' where status = 'pending';
update public.chain_writes set status = 'pending' where status = 'failed';
reset role;
select is((select array_agg(status order by tx_hash) from public.chain_writes),
  array['confirmed', 'pending', 'failed'], 'nor change a status');

set local role service_role;
select lives_ok($$ select pg_temp.write(4, 8, 'pending') $$, 'the service role inserts a pending write');
select lives_ok($$ update public.chain_writes set status = 'confirmed' where tx_hash = lpad(to_hex(8), 64, '0') $$,
  'and settles it');
reset role;
select is((select status from public.chain_writes where tx_hash = lpad(to_hex(8), 64, '0')), 'confirmed',
  'which the chain-jobs run relies on');
delete from public.chain_writes where tx_hash = lpad(to_hex(8), 64, '0');

-- ---------------------------------------------------------------------------
-- A failed write keeps no note
-- ---------------------------------------------------------------------------

select lives_ok($$ delete from public.documents where id = '51000000-0000-4000-8000-000000000003' $$,
  'a note whose only write failed can be deleted');
select is((select count(*)::int from public.chain_writes where document_id = '51000000-0000-4000-8000-000000000003'), 0,
  'and its failed write goes with it');
select throws_ok($$ delete from public.documents where id = '51000000-0000-4000-8000-000000000002' $$,
  '23001', null, 'a pending write still keeps its note: it may yet land');
select throws_ok($$ delete from public.documents where id = '51000000-0000-4000-8000-000000000001' $$,
  '23001', null, 'and so does a confirmed one');

select * from finish();
rollback;
