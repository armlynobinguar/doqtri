-- pgTAP tests for deleting an account (WP-1.9): D-49, D-50 and D-51 as
-- 20261024150500_workspace_members_management.sql implements them, with
-- 20261024160000_workspace_member_removals.sql's log alongside, and D-63's
-- anonymisation (20261026100000_account_deletion_anonymises.sql, WP-1.11)
-- in place of D-51's refusals.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/account_deletion.test.sql
--
-- One transaction, rolled back. Users are signed in by switching to the
-- authenticated role with their id in the JWT claims (auth.uid()).
--
-- Cast:
--   o  owner@example.com     owns the team workspace "Acme", no wallet
--   q  other@example.com     owns the team workspace "Beta", no wallet
--   x  friend@example.com    owns a personal workspace others are in
--   p  passkey@example.com   a passkey wallet on testnet and on mainnet:
--                            editor of Acme, admin of Beta, editor of x's
--                            personal workspace, viewer elsewhere
--   f  a Freighter account   (G...): editor of Acme and of x's personal
--                            workspace
--   u  unconfirmed@example.com, never confirmed (D-49)
--   m  market@example.com    editor of Acme, has a template draft and
--                            has bought one of o's

begin;
create extension if not exists pgtap with schema extensions;

select plan(43);

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000000c1', 'owner@example.com', now()),
  ('00000000-0000-4000-8000-0000000000c2', 'other@example.com', now()),
  ('00000000-0000-4000-8000-0000000000c3', 'friend@example.com', now()),
  ('00000000-0000-4000-8000-0000000000c4', 'Passkey@Example.com', now()),
  ('00000000-0000-4000-8000-0000000000c5', lower('G' || repeat('F', 55)) || '@stellar.doqtri.local', now());
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000c6', 'unconfirmed@example.com');

insert into public.smart_wallets (user_id, network, address, created_tx) values
  ('00000000-0000-4000-8000-0000000000c4', 'testnet', 'C' || repeat('P', 55), repeat('a', 64)),
  ('00000000-0000-4000-8000-0000000000c4', 'mainnet', 'C' || repeat('Q', 55), repeat('b', 64));
insert into public.wallet_passkeys (credential_id, user_id, network, public_key, rp_id) values
  ('passkey-testnet', '00000000-0000-4000-8000-0000000000c4', 'testnet',
   '\x04'::bytea || decode(repeat('11', 64), 'hex'), 'www.doqtri.xyz'),
  ('passkey-mainnet', '00000000-0000-4000-8000-0000000000c4', 'mainnet',
   '\x04'::bytea || decode(repeat('22', 64), 'hex'), 'www.doqtri.xyz');
insert into public.wallet_accounts (address, user_id) values
  ('G' || repeat('F', 55), '00000000-0000-4000-8000-0000000000c5');

insert into public.workspaces (id, name, slug, created_by) values
  ('12000000-0000-4000-8000-000000000001', 'Acme', 'acme-wp19', '00000000-0000-4000-8000-0000000000c1'),
  ('12000000-0000-4000-8000-000000000002', 'Beta', 'beta-wp19', '00000000-0000-4000-8000-0000000000c2');

create temp table ws as
  select '12000000-0000-4000-8000-000000000001'::uuid as acme,
         '12000000-0000-4000-8000-000000000002'::uuid as beta,
         (select id from public.workspaces
           where is_personal and created_by = '00000000-0000-4000-8000-0000000000c3') as friend,
         (select id from public.workspaces
           where is_personal and created_by = '00000000-0000-4000-8000-0000000000c4') as p_personal;
grant select on ws to authenticated, service_role;

insert into public.workspace_members (workspace_id, user_id, role)
select w.id, m.user_id, m.role::public.workspace_role
  from (values
    ((select acme from ws),   '00000000-0000-4000-8000-0000000000c4'::uuid, 'editor'),
    ((select beta from ws),   '00000000-0000-4000-8000-0000000000c4'::uuid, 'admin'),
    ((select friend from ws), '00000000-0000-4000-8000-0000000000c4'::uuid, 'editor'),
    ((select acme from ws),   '00000000-0000-4000-8000-0000000000c5'::uuid, 'editor'),
    ((select friend from ws), '00000000-0000-4000-8000-0000000000c5'::uuid, 'editor'),
    ((select beta from ws),   '00000000-0000-4000-8000-0000000000c5'::uuid, 'viewer')
  ) as m (workspace_id, user_id, role)
  join public.workspaces w on w.id = m.workspace_id;


-- ---------------------------------------------------------------------------
-- The wallet foreign keys (D-51)
-- ---------------------------------------------------------------------------

select is(
  (select confdeltype::text from pg_constraint where conname = 'smart_wallets_user_id_fkey'),
  'c', 'a passkey wallet record cascades with its account, so a passkey account can be deleted (D-51)');
select is(
  (select confdeltype::text from pg_constraint where conname = 'wallet_passkeys_user_id_network_fkey'),
  'c', 'and its passkeys with the wallet record');
select is(
  (select confdeltype::text from pg_constraint where conname = 'wallet_accounts_user_id_fkey'),
  'c', 'a Freighter account''s address mapping cascades too, as it always did');


-- ---------------------------------------------------------------------------
-- Confirmed emails only (D-49)
-- ---------------------------------------------------------------------------

select is(public.find_account('unconfirmed@example.com'), null::uuid,
  'find_account does not match an email that was never confirmed');
select is(public.find_account('  PASSKEY@example.com '), '00000000-0000-4000-8000-0000000000c4'::uuid,
  'it matches a confirmed one, trimmed and in any case');
select is(public.find_account('C' || repeat('Q', 55)), '00000000-0000-4000-8000-0000000000c4'::uuid,
  'and a passkey wallet on any network');
select is(public.find_account('G' || repeat('F', 55)), '00000000-0000-4000-8000-0000000000c5'::uuid,
  'and a Freighter account');
select is(public.invite_identifiers_of('00000000-0000-4000-8000-0000000000c6'), '{}'::text[],
  'an unconfirmed account has no identifier an invite could reach');

update public.invite_settings set email_invites = true;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000c6","role":"authenticated"}';
select is(public.my_invite_identifiers(), '{}'::text[],
  'with email invites on, an unconfirmed account is still delivered nothing by its email');
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000c4","role":"authenticated"}';
select is(
  (select array_agg(x order by x) from unnest(public.my_invite_identifiers()) x),
  array['C' || repeat('P', 55), 'C' || repeat('Q', 55), 'passkey@example.com'],
  'a confirmed passkey account is reached by its email and both its wallets');
reset role;
update auth.users set email_confirmed_at = now() where id = '00000000-0000-4000-8000-0000000000c6';
select is(public.find_account('unconfirmed@example.com'), '00000000-0000-4000-8000-0000000000c6'::uuid,
  'once confirmed, the same email finds its account');
update auth.users set email_confirmed_at = null where id = '00000000-0000-4000-8000-0000000000c6';
update public.invite_settings set email_invites = false;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000c4","role":"authenticated"}';
select is(
  (select array_agg(x order by x) from unnest(public.my_invite_identifiers()) x),
  array['C' || repeat('P', 55), 'C' || repeat('Q', 55)],
  'with email invites off, only the wallets are delivered to');
reset role;


-- ---------------------------------------------------------------------------
-- Deleting a passkey account (D-50, D-51)
-- ---------------------------------------------------------------------------

-- Open invites to p's identifiers, and to other people's.
insert into public.workspace_invites (workspace_id, invitee, role, invited_by) values
  ((select acme from ws), 'passkey@example.com',  'admin',  '00000000-0000-4000-8000-0000000000c1'),
  ((select acme from ws), 'C' || repeat('Q', 55), 'viewer', '00000000-0000-4000-8000-0000000000c1'),
  ((select beta from ws), 'C' || repeat('P', 55), 'editor', '00000000-0000-4000-8000-0000000000c2'),
  ((select acme from ws), 'unconfirmed@example.com', 'viewer', '00000000-0000-4000-8000-0000000000c1'),
  ((select acme from ws), 'someone@example.com',  'viewer', '00000000-0000-4000-8000-0000000000c1');
-- And p's own invites to others, as Beta's admin.
insert into public.workspace_invites (workspace_id, invitee, role, invited_by) values
  ((select beta from ws), 'C' || repeat('Z', 55), 'viewer', '00000000-0000-4000-8000-0000000000c4');
-- A note p wrote in Acme stays there.
insert into public.documents (id, user_id, workspace_id, title, markdown) values
  ('32000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c4',
   (select acme from ws), 'Team plan', '# Team plan');

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000c4' $$,
  'a passkey account in several workspaces deletes itself (D-51)');

select results_eq(
  $$ select j.address, j.network
       from public.workspace_chain_jobs j
      where j.workspace_id = (select acme from ws) and j.kind = 'revoke' and j.status = 'pending'
        and j.address like 'C%'
      order by j.address $$,
  $$ values ('C' || repeat('P', 55), 'testnet'::text), ('C' || repeat('Q', 55), 'mainnet'::text) $$,
  'its editor role in a team workspace is queued for revocation, by each wallet on its own network');
select results_eq(
  $$ select j.address from public.workspace_chain_jobs j
      where j.workspace_id = (select beta from ws) and j.kind = 'revoke' and j.status = 'pending'
      order by j.address $$,
  $$ values ('C' || repeat('P', 55)), ('C' || repeat('Q', 55)) $$,
  'and its admin role in another team workspace');
select results_eq(
  $$ select j.address from public.workspace_chain_jobs j
      where j.workspace_id = (select friend from ws) and j.kind = 'revoke' and j.status = 'pending'
        and j.address like 'C%'
      order by j.address $$,
  $$ values ('C' || repeat('P', 55)), ('C' || repeat('Q', 55)) $$,
  'and its editor role in someone else''s personal workspace, like anywhere else');
select is(
  (select count(*)::int from public.workspace_chain_jobs
    where user_id is null and address in ('C' || repeat('P', 55), 'C' || repeat('Q', 55))),
  6, 'the jobs outlive the account, naming the wallet rather than the user');
select is(
  (select count(*)::int from public.workspace_chain_jobs j
    join public.workspaces w on w.id = j.workspace_id
   where w.created_by = '00000000-0000-4000-8000-0000000000c4'),
  0, 'nothing is queued for its own personal workspace, which goes with it');

select is((select count(*)::int from public.smart_wallets where user_id = '00000000-0000-4000-8000-0000000000c4'),
  0, 'then both wallet records are retired');
select is((select count(*)::int from public.wallet_passkeys where user_id = '00000000-0000-4000-8000-0000000000c4'),
  0, 'with their passkeys');
select is((select count(*)::int from public.workspaces w where w.id = (select p_personal from ws)),
  0, 'and its personal workspace');

select results_eq(
  $$ select w.name, r.role::text, r.wallet_addresses
       from public.workspace_member_removals r
       join public.workspaces w on w.id = r.workspace_id
      where r.user_id = '00000000-0000-4000-8000-0000000000c4'
      order by w.name $$,
  $$ values ('Acme'::text, 'editor'::text, array['C' || repeat('P', 55), 'C' || repeat('Q', 55)]),
            ('Beta'::text, 'admin'::text, array['C' || repeat('P', 55), 'C' || repeat('Q', 55)]),
            ('friend'::text, 'editor'::text, array['C' || repeat('P', 55), 'C' || repeat('Q', 55)]) $$,
  'the audit log keeps every workspace it could sign in, with both wallet addresses (WP-1.8)');

select is(
  (select count(*)::int from public.workspace_invites
    where invitee in ('passkey@example.com', 'C' || repeat('P', 55), 'C' || repeat('Q', 55))),
  0, 'the open invites to its email and both wallets are deleted (D-50)');
select is(
  (select count(*)::int from public.workspace_invites where invitee = 'C' || repeat('Z', 55)),
  0, 'and the invites it sent as an admin are withdrawn');
select is(
  (select count(*)::int from public.workspace_invites
    where invitee in ('unconfirmed@example.com', 'someone@example.com')),
  2, 'invites to other people stay');

select results_eq(
  $$ select workspace_id, user_id from public.documents where id = '32000000-0000-4000-8000-000000000001' $$,
  $$ select acme, null::uuid from ws $$,
  'its note in the team workspace stays there, author-less (D-56)');
select is(
  (select count(*)::int from public.workspace_members where user_id = '00000000-0000-4000-8000-0000000000c4'),
  0, 'and it is in no workspace any more');


-- ---------------------------------------------------------------------------
-- Deleting a Freighter account (D-50, D-51)
-- ---------------------------------------------------------------------------

insert into public.workspace_invites (workspace_id, invitee, role, invited_by) values
  ((select beta from ws), 'G' || repeat('F', 55), 'editor', '00000000-0000-4000-8000-0000000000c2');

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000c5' $$,
  'a Freighter account deletes itself');
select results_eq(
  $$ select w.name, j.network
       from public.workspace_chain_jobs j
       join public.workspaces w on w.id = j.workspace_id
      where j.kind = 'revoke' and j.address = 'G' || repeat('F', 55)
      order by w.name $$,
  $$ values ('Acme'::text, null::text), ('friend'::text, null::text) $$,
  'its editor roles, in a team workspace and in someone else''s personal one, are queued by its G address');
select is(
  (select count(*)::int from public.workspace_chain_jobs j
    where j.workspace_id = (select beta from ws) and j.address = 'G' || repeat('F', 55)),
  0, 'a viewer role held nothing on-chain and queues nothing');
select is((select count(*)::int from public.wallet_accounts where address = 'G' || repeat('F', 55)),
  0, 'its address mapping goes with it');
select results_eq(
  $$ select w.name, r.wallet_addresses
       from public.workspace_member_removals r
       join public.workspaces w on w.id = r.workspace_id
      where r.user_id = '00000000-0000-4000-8000-0000000000c5'
      order by w.name $$,
  $$ values ('Acme'::text, array['G' || repeat('F', 55)]), ('friend'::text, array['G' || repeat('F', 55)]) $$,
  'the audit log keeps its G address for each workspace it could sign in');
select is((select count(*)::int from public.workspace_invites where invitee = 'G' || repeat('F', 55)),
  0, 'the open invite to its Stellar account is deleted (D-50)');


-- ---------------------------------------------------------------------------
-- An unconfirmed account (D-49, D-50)
-- ---------------------------------------------------------------------------

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000c6' $$,
  'an account that never confirmed its email deletes itself');
select is((select count(*)::int from public.workspace_invites where invitee = 'unconfirmed@example.com'),
  1, 'the invite to that email stays, for whoever owns the inbox');


-- ---------------------------------------------------------------------------
-- What no longer refuses a deletion (D-63), and what still does (D-31)
-- ---------------------------------------------------------------------------
--
-- D-51 refused an account with an anchored personal note or a template it
-- published or bought; D-63 anonymises it instead and keeps all of that.
-- account_anonymisation.test.sql covers what is kept and what is removed in
-- detail; here, the same accounts that used to be refused.

-- x holds a passkey wallet and anchored a personal note through the relay.
insert into public.smart_wallets (user_id, network, address, created_tx) values
  ('00000000-0000-4000-8000-0000000000c3', 'testnet', 'C' || repeat('X', 55), repeat('c', 64));
insert into public.workspace_members (workspace_id, user_id, role) values
  ((select acme from ws), '00000000-0000-4000-8000-0000000000c3', 'editor');
insert into public.documents (id, user_id, workspace_id, title, markdown) values
  ('32000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000c3',
   (select friend from ws), 'Mine', '# Mine');
insert into public.chain_writes (network, tx_hash, document_id, fn, owner) values
  ('testnet', repeat('d', 64), '32000000-0000-4000-8000-000000000002', 'anchor', 'C' || repeat('X', 55));

-- The last owner of a team workspace with no admin (D-31) is still refused.
select throws_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000c2' $$,
  '23001', null, 'the last owner of a team workspace with nobody to hand it to is refused');

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000c3' $$,
  'an account with an anchored personal note deletes itself (D-63)');
select results_eq(
  $$ select j.address from public.workspace_chain_jobs j
      where j.workspace_id = (select acme from ws) and j.kind = 'revoke' and j.address = 'C' || repeat('X', 55) $$,
  $$ values ('C' || repeat('X', 55)) $$,
  'its editor role in a team workspace is queued for revocation first, as for anyone');
select is((select count(*)::int from public.smart_wallets where address = 'C' || repeat('X', 55)),
  0, 'its wallet record is retired');
select results_eq(
  $$ select d.workspace_id, d.user_id, (select count(*)::int from public.chain_writes c where c.document_id = d.id)
       from public.documents d where d.id = '32000000-0000-4000-8000-000000000002' $$,
  $$ select friend, null::uuid, 1 from ws $$,
  'and the anchored note stays where it was, author-less, with its record');

-- m has published a template (a draft) and bought one of o's.
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000000c7', 'market@example.com', now());
insert into public.workspace_members (workspace_id, user_id, role) values
  ((select acme from ws), '00000000-0000-4000-8000-0000000000c7', 'editor');
insert into public.market_templates
  (id, network, creator_id, creator_wallet, title, category, body, content_hash, token, price, status) values
  ('aaaaaaaaaaaaaaaa', 'testnet', '00000000-0000-4000-8000-0000000000c1', 'G' || repeat('O', 55),
   'Roadmap', 'Planning', 'body', repeat('e', 64), 'C' || repeat('T', 55), 0, 'listed'),
  ('bbbbbbbbbbbbbbbb', 'testnet', '00000000-0000-4000-8000-0000000000c7', 'G' || repeat('M', 55),
   'Draft', 'Work', 'body', repeat('f', 64), 'C' || repeat('T', 55), 0, 'pending');
insert into public.market_purchases (network, template_id, buyer_id, buyer_wallet, amount) values
  ('testnet', 'aaaaaaaaaaaaaaaa', '00000000-0000-4000-8000-0000000000c7', 'G' || repeat('M', 55), 0);

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000c7' $$,
  'an account with a template it published and one it bought deletes itself (D-63)');
-- A draft never confirmed on chain goes with the account (D-89,
-- 20261026120000); listed templates are covered in
-- account_deletion_market_templates.test.sql.
select is((select count(*)::int from public.market_templates where id = 'bbbbbbbbbbbbbbbb'),
  0, 'its draft template, never confirmed on chain, is deleted');
select results_eq(
  $$ select template_id, buyer_id, buyer_wallet from public.market_purchases where template_id = 'aaaaaaaaaaaaaaaa' $$,
  $$ values ('aaaaaaaaaaaaaaaa'::text, null::uuid, 'G' || repeat('M', 55)) $$,
  'and its purchase stays on record, by its wallet');

select * from finish();
rollback;
