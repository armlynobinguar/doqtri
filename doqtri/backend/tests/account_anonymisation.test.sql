-- pgTAP tests for 20261026100000_account_deletion_anonymises.sql (WP-1.11):
-- deleting an account anonymises it and keeps the content (D-63).
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/account_anonymisation.test.sql
--
-- One transaction, rolled back. Users are signed in by switching to the
-- authenticated role with their id in the JWT claims (auth.uid()).
--
-- Cast:
--   a  anon@example.com    the account deleted: a passkey wallet, a personal
--                          workspace with an anchored note (headings public),
--                          a private draft and a qdit-linked note, b as a
--                          viewer there; editor of Acme with a note there;
--                          a listed template, bought by c; a template of o's
--                          it bought; a qdit connection; an open invite; a
--                          lock, a map style and two imports
--   b  buddy@example.com   viewer of a's personal workspace
--   c  buyer@example.com   bought a's template
--   o  a Freighter account, owns Acme
--   h  heir@example.com    admin of Acme

begin;
create extension if not exists pgtap with schema extensions;

select plan(28);

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000d1', 'anon@example.com', now(),
   '{"full_name": "Ana Nonymous", "avatar_url": "https://example.com/ana.png", "bio": "Plans things"}'),
  ('00000000-0000-4000-8000-0000000000d2', 'buddy@example.com', now(), '{}'),
  ('00000000-0000-4000-8000-0000000000d3', 'buyer@example.com', now(), '{}'),
  ('00000000-0000-4000-8000-0000000000d4', lower('G' || repeat('O', 55)) || '@stellar.doqtri.local', now(), '{}'),
  ('00000000-0000-4000-8000-0000000000d5', 'heir@example.com', now(), '{}');

insert into public.smart_wallets (user_id, network, address, created_tx) values
  ('00000000-0000-4000-8000-0000000000d1', 'testnet', 'C' || repeat('A', 55), repeat('a', 64)),
  ('00000000-0000-4000-8000-0000000000d5', 'testnet', 'C' || repeat('H', 55), repeat('b', 64));
insert into public.wallet_passkeys (credential_id, user_id, network, public_key, rp_id) values
  ('passkey-ana', '00000000-0000-4000-8000-0000000000d1', 'testnet',
   '\x04'::bytea || decode(repeat('11', 64), 'hex'), 'www.doqtri.xyz');
insert into public.wallet_accounts (address, user_id) values
  ('G' || repeat('O', 55), '00000000-0000-4000-8000-0000000000d4');

insert into public.workspaces (id, name, slug, created_by) values
  ('13000000-0000-4000-8000-000000000001', 'Acme', 'acme-wp111', '00000000-0000-4000-8000-0000000000d4');

create temp table ws as
  select '13000000-0000-4000-8000-000000000001'::uuid as acme,
         (select id from public.workspaces
           where is_personal and created_by = '00000000-0000-4000-8000-0000000000d1') as a_personal;
grant select on ws to authenticated, service_role;

insert into public.workspace_members (workspace_id, user_id, role)
select w, u, r::public.workspace_role
  from (values
    ((select a_personal from ws), '00000000-0000-4000-8000-0000000000d2'::uuid, 'viewer'),
    ((select acme from ws),       '00000000-0000-4000-8000-0000000000d1'::uuid, 'editor'),
    ((select acme from ws),       '00000000-0000-4000-8000-0000000000d5'::uuid, 'admin')
  ) as m (w, u, r);

insert into public.documents (id, user_id, workspace_id, title, markdown, publish_headings) values
  ('33000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000d1',
   (select a_personal from ws), 'Anchored plan', '# Anchored plan' || chr(10) || '## Ship', true),
  ('33000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000d1',
   (select a_personal from ws), 'Private draft', '# Private draft', false),
  ('33000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-0000000000d1',
   (select a_personal from ws), 'Linked plan', '# Linked plan' || chr(10) || '## M1', false),
  ('33000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000d1',
   (select acme from ws), 'Team plan', '# Team plan', false);
insert into public.chain_writes (network, tx_hash, document_id, fn, owner) values
  ('testnet', repeat('c', 64), '33000000-0000-4000-8000-000000000001', 'anchor', 'C' || repeat('A', 55));
insert into public.doc_project_links
  (document_id, project_id, project_name, project_slug, qdit_link_id, doc_url, linked_by) values
  ('33000000-0000-4000-8000-000000000003', '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', 'Payroll', 'payroll',
   '9b5c4d3e-2f10-4b0a-9d8e-7f6a5b4c3d2e', 'https://doqtri.test/d/33000000-0000-4000-8000-000000000003',
   '00000000-0000-4000-8000-0000000000d1');
insert into public.node_links
  (id, user_id, document_id, node_id, node_label, provider,
   qdit_project_id, qdit_milestone_id, qdit_link_id, qdit_state) values
  ('43000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000d1',
   '33000000-0000-4000-8000-000000000003', 'h1', 'M1', 'qdit',
   '3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34', '5d6e7f80-9a1b-4c2d-8e3f-405162738495',
   '6e7f8091-a2b3-4c4d-9e5f-60718293a4b5', 'linked');

insert into public.ingests (id, user_id, object_path, filename, kind, status, document_id) values
  ('53000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000d1',
   '00000000-0000-4000-8000-0000000000d1/plan.pdf', 'plan.pdf', 'pdf', 'succeeded',
   '33000000-0000-4000-8000-000000000001'),
  ('53000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000d1',
   '00000000-0000-4000-8000-0000000000d1/broken.pdf', 'broken.pdf', 'pdf', 'failed', null);
insert into public.doc_locks (document_id, holder, session_id) values
  ('33000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-0000000000d1', gen_random_uuid());
insert into public.mindmap_styles (user_id, scope, document_id, style) values
  ('00000000-0000-4000-8000-0000000000d1', 'global', null, '{}');
insert into public.chain_usage (user_id, network, kind) values
  ('00000000-0000-4000-8000-0000000000d1', 'testnet', 'write');

insert into public.integration_connections
  (user_id, provider, subject, account_label, scopes, access_token_ciphertext, refresh_token_ciphertext, expires_at,
   previous_subject, previous_account_label) values
  ('00000000-0000-4000-8000-0000000000d1', 'qdit', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', 'ana-in-qdit',
   '{openid}', 'v1.access-ciphertext', 'v1.refresh-ciphertext', now() + interval '1 hour',
   '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', 'ana-old');
insert into public.workspace_invites (workspace_id, invitee, role, invited_by) values
  ((select acme from ws), 'anon@example.com', 'admin', '00000000-0000-4000-8000-0000000000d4');

insert into public.market_templates
  (id, network, creator_id, creator_wallet, title, category, body, content_hash, token, price, status, listed_at) values
  ('cccccccccccccccc', 'testnet', '00000000-0000-4000-8000-0000000000d1', 'C' || repeat('A', 55),
   'Launch plan', 'Planning', 'body', repeat('d', 64), 'C' || repeat('T', 55), 10000000, 'listed', now()),
  ('dddddddddddddddd', 'testnet', '00000000-0000-4000-8000-0000000000d4', 'G' || repeat('O', 55),
   'Roadmap', 'Planning', 'body', repeat('e', 64), 'C' || repeat('T', 55), 0, 'listed', now());
insert into public.market_purchases (network, template_id, buyer_id, buyer_wallet, amount, tx_hash) values
  ('testnet', 'cccccccccccccccc', '00000000-0000-4000-8000-0000000000d3', 'G' || repeat('C', 55), 10000000, repeat('f', 64)),
  ('testnet', 'dddddddddddddddd', '00000000-0000-4000-8000-0000000000d1', 'C' || repeat('A', 55), 0, null);


-- ---------------------------------------------------------------------------
-- No foreign key takes the content with the account
-- ---------------------------------------------------------------------------

select is(
  (select array_agg(c.conrelid::regclass::text || '.' || a.attname order by 1)
     from pg_constraint c
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'auth.users'::regclass and c.confdeltype in ('c', 'r')
      and c.conrelid::regclass::text in ('documents', 'node_links', 'doc_project_links', 'market_templates',
                                          'market_purchases', 'workspaces', 'chain_writes')),
  null::text[],
  'no content table cascades with, or restricts, an account''s deletion');


-- ---------------------------------------------------------------------------
-- Deleting the account
-- ---------------------------------------------------------------------------

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000d1' $$,
  'an account with anchored notes, a template, purchases and a qdit connection deletes itself (D-63)');


-- Personal data: gone.

select is((select count(*)::int from auth.users where id = '00000000-0000-4000-8000-0000000000d1'),
  0, 'the account row, with its email and profile metadata, is gone');
select is(public.account_label('00000000-0000-4000-8000-0000000000d1'), null,
  'nothing names it any more: the app shows "Former user"');
select is((select count(*)::int from public.integration_connections where user_id = '00000000-0000-4000-8000-0000000000d1'),
  0, 'its qdit connection and tokens are gone');
select is((select count(*)::int from public.smart_wallets where user_id = '00000000-0000-4000-8000-0000000000d1')
        + (select count(*)::int from public.wallet_passkeys where user_id = '00000000-0000-4000-8000-0000000000d1'),
  0, 'its wallet record and passkey are retired (D-51)');
select is((select count(*)::int from public.workspace_invites where invitee = 'anon@example.com'),
  0, 'the invite to its email is deleted (D-50)');
select is((select count(*)::int from public.doc_locks where holder = '00000000-0000-4000-8000-0000000000d1')
        + (select count(*)::int from public.mindmap_styles where user_id = '00000000-0000-4000-8000-0000000000d1')
        + (select count(*)::int from public.chain_usage where user_id = '00000000-0000-4000-8000-0000000000d1'),
  0, 'its lock, map style and relay usage are gone');
select is((select count(*)::int from public.ingests where id = '53000000-0000-4000-8000-000000000002'),
  0, 'an import that never became a note goes with it');

-- Every uuid column in public that could name an account, checked by
-- catalogue rather than by list, so a table added later is covered too.
-- workspace_member_removals keeps the id on purpose (no foreign key; the
-- audit trail outlives the account, 20261024160000) and names no one.
create function pg_temp.columns_naming(p_user uuid) returns text[]
language plpgsql as $$
declare
  v_col record;
  v_hit boolean;
  v_out text[] := '{}';
begin
  for v_col in
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = 'public' and c.data_type = 'uuid'
       and c.table_name <> 'workspace_member_removals'
  loop
    execute format('select exists (select 1 from public.%I where %I = $1)', v_col.table_name, v_col.column_name)
      into v_hit using p_user;
    if v_hit then
      v_out := v_out || (v_col.table_name || '.' || v_col.column_name);
    end if;
  end loop;
  return v_out;
end;
$$;
select is(pg_temp.columns_naming('00000000-0000-4000-8000-0000000000d1'), '{}'::text[],
  'no row in public names the account by id');

create function pg_temp.columns_containing(p_text text) returns text[]
language plpgsql as $$
declare
  v_col record;
  v_hit boolean;
  v_out text[] := '{}';
begin
  for v_col in
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = 'public' and c.data_type in ('text', 'character varying', 'jsonb', 'ARRAY')
  loop
    execute format('select exists (select 1 from public.%I where %I::text ilike $1)', v_col.table_name, v_col.column_name)
      into v_hit using '%' || p_text || '%';
    if v_hit then
      v_out := v_out || (v_col.table_name || '.' || v_col.column_name);
    end if;
  end loop;
  return v_out;
end;
$$;
select is(pg_temp.columns_containing('anon@example.com'), '{}'::text[],
  'nor by email');
select is(pg_temp.columns_containing('Payroll') || pg_temp.columns_naming('00000000-0000-4000-8000-0000000000d2'),
  array['doc_project_links.project_name', 'doc_project_links.project_slug',
        'workspaces.created_by', 'workspace_members.user_id'],
  'the same scans do find what is still there (a control for the two above and the one below)');
select is(pg_temp.columns_containing('Ana Nonymous') || pg_temp.columns_containing('ana-in-qdit')
          || pg_temp.columns_containing('ana-old') || pg_temp.columns_containing('ana.png'),
  '{}'::text[], 'nor by display name, qdit account name or avatar');


-- Content: kept.

select results_eq(
  $$ select d.id::text, d.user_id from public.documents d
      where d.id::text like '33000000-%' order by d.id $$,
  $$ values ('33000000-0000-4000-8000-000000000001', null::uuid),
            ('33000000-0000-4000-8000-000000000002', null::uuid),
            ('33000000-0000-4000-8000-000000000003', null::uuid),
            ('33000000-0000-4000-8000-000000000004', null::uuid) $$,
  'every note it wrote stays, anchored or not, personal or team, author-less');
select results_eq(
  $$ select w.name, w.created_by, w.is_personal from public.workspaces w where w.id = (select a_personal from ws) $$,
  $$ values ('Former user'::text, null::uuid, true) $$,
  'its personal workspace stays, named "Former user" instead of after the email');
select results_eq(
  $$ select m.user_id, m.role::text from public.workspace_members m where m.workspace_id = (select a_personal from ws) $$,
  $$ values ('00000000-0000-4000-8000-0000000000d2'::uuid, 'viewer'::text) $$,
  'with its viewer still there, and no owner');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000d2","role":"authenticated"}';
select is((select count(*)::int from public.documents where workspace_id = (select a_personal from ws)),
  3, 'the viewer still reads its notes');
select results_eq(
  $$ select name from public.workspaces where id = (select a_personal from ws) $$,
  $$ values ('Former user'::text) $$,
  'and sees the workspace as "Former user"');
reset role;

select results_eq(
  $$ select l.project_name, l.linked_by, (select count(*)::int from public.node_links n
                                           where n.document_id = l.document_id and n.provider = 'qdit' and n.user_id is null)
       from public.doc_project_links l where l.document_id = '33000000-0000-4000-8000-000000000003' $$,
  $$ values ('Payroll'::text, null::uuid, 1) $$,
  'the qdit-linked note keeps its project and milestone links, author-less');
select results_eq(
  $$ select user_id, document_id from public.ingests where id = '53000000-0000-4000-8000-000000000001' $$,
  $$ values (null::uuid, '33000000-0000-4000-8000-000000000001'::uuid) $$,
  'the import behind a kept note stays with the note (D-42), detached from the account');

select results_eq(
  $$ select creator_id, creator_wallet, status, hidden from public.market_templates where id = 'cccccccccccccccc' $$,
  $$ values (null::uuid, 'C' || repeat('A', 55), 'listed'::text, false) $$,
  'its template stays listed, credited to its wallet');
select results_eq(
  $$ select buyer_id, buyer_wallet, tx_hash from public.market_purchases where template_id = 'cccccccccccccccc' $$,
  $$ values ('00000000-0000-4000-8000-0000000000d3'::uuid, 'G' || repeat('C', 55), repeat('f', 64)) $$,
  'a buyer''s purchase of it stays valid');
select results_eq(
  $$ select buyer_id, buyer_wallet from public.market_purchases where template_id = 'dddddddddddddddd' $$,
  $$ values (null::uuid, 'C' || repeat('A', 55)) $$,
  'and its own purchase stays on record, by its wallet, for the seller''s earnings');

-- The gallery's read (app/api/market/templates/route.ts): a template whose
-- creator_id is null is shown as by "Former user", with its wallet.
select results_eq(
  $$ select t.id, t.creator_id is null as former, t.creator_wallet
       from public.market_templates t
      where t.network = 'testnet' and t.status = 'listed' and not t.hidden
      order by t.id $$,
  $$ values ('cccccccccccccccc'::text, true, 'C' || repeat('A', 55)),
            ('dddddddddddddddd'::text, false, 'G' || repeat('O', 55)) $$,
  'the gallery still lists it, flagged as a former user''s');


-- The public audit page (/d/[docId]) reads with the service role.

set local role service_role;
select results_eq(
  $$ select owner, fn from public.chain_writes where document_id = '33000000-0000-4000-8000-000000000001' $$,
  $$ values ('C' || repeat('A', 55), 'anchor'::text) $$,
  'the page still finds the anchored note''s writes, signed by its wallet');
select results_eq(
  $$ select title, publish_headings from public.documents where id = '33000000-0000-4000-8000-000000000001' $$,
  $$ values ('Anchored plan'::text, true) $$,
  'and its public headings, which the owner had opted into');
select results_eq(
  $$ select address, revoked_at is null from public.signer_removals_for_document('33000000-0000-4000-8000-000000000004') $$,
  $$ values ('C' || repeat('A', 55), true) $$,
  'a team note lists the former member by wallet address only, until the revocation lands');
reset role;
select results_eq(
  $$ select j.address, j.status from public.workspace_chain_jobs j
      where j.workspace_id = (select acme from ws) and j.kind = 'revoke' $$,
  $$ values ('C' || repeat('A', 55), 'pending'::text) $$,
  'that revocation was queued before the wallet record went');


select * from finish();
rollback;
