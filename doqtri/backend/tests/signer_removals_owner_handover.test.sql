-- pgTAP tests for 20261026100001_signer_removals_owner_handover.sql
-- (WP-1.11, from the WP-1.10 review): an owner's removal takes its revoke
-- time from the workspace's handover.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/signer_removals_owner_handover.test.sql
--
-- One transaction, rolled back.
--
-- Cast:
--   o  a Freighter account (G...), the only owner of Acme
--   h  heir@example.com    Acme's admin, who takes it over (D-31)
--   e  a Freighter account, an editor of Acme

begin;
create extension if not exists pgtap with schema extensions;

select plan(9);

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000000e1', lower('G' || repeat('O', 55)) || '@stellar.doqtri.local', now()),
  ('00000000-0000-4000-8000-0000000000e2', 'heir@example.com', now()),
  ('00000000-0000-4000-8000-0000000000e3', lower('G' || repeat('E', 55)) || '@stellar.doqtri.local', now());
insert into public.wallet_accounts (address, user_id) values
  ('G' || repeat('O', 55), '00000000-0000-4000-8000-0000000000e1'),
  ('G' || repeat('E', 55), '00000000-0000-4000-8000-0000000000e3');
insert into public.workspaces (id, name, slug, created_by) values
  ('14000000-0000-4000-8000-000000000001', 'Acme', 'acme-owner-handover', '00000000-0000-4000-8000-0000000000e1');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('14000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e2', 'admin'),
  ('14000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e3', 'editor');
insert into public.documents (id, user_id, workspace_id, title, markdown) values
  ('34000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e2',
   '14000000-0000-4000-8000-000000000001', 'Plan', '# Plan');

create function pg_temp.revoked_at(p_address text) returns timestamptz
language sql as $$
  select s.revoked_at from public.signer_removals_for_document('34000000-0000-4000-8000-000000000001') s
   where s.address = p_address
$$;

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000e1' $$,
  'Acme''s owner deletes their account');
select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000e3' $$,
  'and so does its editor');
select results_eq(
  $$ select role::text, wallet_addresses from public.workspace_member_removals
      where workspace_id = '14000000-0000-4000-8000-000000000001' order by role $$,
  $$ values ('editor'::text, array['G' || repeat('E', 55)]), ('owner'::text, array['G' || repeat('O', 55)]) $$,
  'both removals are logged, the owner''s with role owner');
select results_eq(
  $$ select kind, coalesce(address, '-') from public.workspace_chain_jobs
      where workspace_id = '14000000-0000-4000-8000-000000000001' order by kind $$,
  $$ values ('reassign_owner'::text, '-'::text), ('revoke'::text, 'G' || repeat('E', 55)) $$,
  'the owner''s role leaves by the handover, the editor''s by a revocation');

select is(pg_temp.revoked_at('G' || repeat('O', 55)), null,
  'while the handover is pending, the owner''s removal has no revoke time');

update public.workspace_chain_jobs set status = 'done'
 where workspace_id = '14000000-0000-4000-8000-000000000001' and kind = 'reassign_owner';
select is(pg_temp.revoked_at('G' || repeat('O', 55)),
  (select done_at from public.workspace_chain_jobs
    where workspace_id = '14000000-0000-4000-8000-000000000001' and kind = 'reassign_owner'),
  'once it is done, the owner''s removal was revoked when the handover was done');
select is(pg_temp.revoked_at('G' || repeat('E', 55)), null,
  'an editor''s removal does not take the handover''s time: it waits for its own revocation');

-- A revocation of the owner's wallet, done later, comes first.
insert into public.workspace_chain_jobs (workspace_id, kind, address, status, done_at)
values ('14000000-0000-4000-8000-000000000001', 'revoke', 'G' || repeat('O', 55), 'done', now() + interval '1 minute');
select is(pg_temp.revoked_at('G' || repeat('O', 55)), now() + interval '1 minute',
  'a revocation of that wallet, where there is one, is used instead');
delete from public.workspace_chain_jobs
 where workspace_id = '14000000-0000-4000-8000-000000000001' and kind = 'revoke' and address = 'G' || repeat('O', 55);

-- A handover done after the owner was restored does not count.
update public.workspace_member_removals
   set removed_at = now() - interval '1 hour', restored_at = now() - interval '30 minutes'
 where workspace_id = '14000000-0000-4000-8000-000000000001' and role = 'owner';
select is(pg_temp.revoked_at('G' || repeat('O', 55)), null,
  'a handover done after the restoration is not the removal''s revoke time');

select * from finish();
rollback;
