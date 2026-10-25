-- pgTAP tests for 20261026120000_account_deletion_market_templates.sql
-- (WP-1.12, D-89): a deleted creator's free templates stay listed, paid
-- ones are hidden, drafts never confirmed on chain are deleted, and buyers
-- keep what they bought.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/account_deletion_market_templates.test.sql
--
-- One transaction, rolled back. Every query is scoped to this file's own
-- template ids, so it passes on a database with production data too.
--
-- Cast:
--   k  creator@example.com  the account deleted: a free listed template, a
--                           paid listed one, a paid delisted one and a
--                           pending draft
--   y  buyer@example.com    bought the paid listed one
--   z  other@example.com    another creator, with a paid listed template

begin;
create extension if not exists pgtap with schema extensions;

select plan(12);

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000000e1', 'creator@example.com', now()),
  ('00000000-0000-4000-8000-0000000000e2', 'buyer@example.com', now()),
  ('00000000-0000-4000-8000-0000000000e3', 'other@example.com', now());

insert into public.market_templates
  (id, network, creator_id, creator_wallet, title, category, body, content_hash, token, price, status, listed_at) values
  ('kfreelistedaaaaa', 'testnet', '00000000-0000-4000-8000-0000000000e1', 'G' || repeat('K', 55),
   'Free plan', 'Planning', 'free body', repeat('a', 64), 'C' || repeat('T', 55), 0, 'listed', now()),
  ('kpaidlistedaaaaa', 'testnet', '00000000-0000-4000-8000-0000000000e1', 'G' || repeat('K', 55),
   'Paid plan', 'Planning', 'paid body', repeat('b', 64), 'C' || repeat('T', 55), 10000000, 'listed', now()),
  ('kpaiddelistedaaa', 'testnet', '00000000-0000-4000-8000-0000000000e1', 'G' || repeat('K', 55),
   'Old paid plan', 'Planning', 'old body', repeat('c', 64), 'C' || repeat('T', 55), 5000000, 'delisted', now()),
  ('kpendingaaaaaaaa', 'testnet', '00000000-0000-4000-8000-0000000000e1', 'G' || repeat('K', 55),
   'Draft', 'Work', 'draft body', repeat('d', 64), 'C' || repeat('T', 55), 10000000, 'pending', null),
  ('zpaidlistedaaaaa', 'testnet', '00000000-0000-4000-8000-0000000000e3', 'G' || repeat('Z', 55),
   'Someone else''s', 'Planning', 'other body', repeat('e', 64), 'C' || repeat('T', 55), 10000000, 'listed', now());
insert into public.market_purchases (network, template_id, buyer_id, buyer_wallet, amount, tx_hash) values
  ('testnet', 'kpaidlistedaaaaa', '00000000-0000-4000-8000-0000000000e2', 'G' || repeat('Y', 55), 10000000, repeat('f', 64));
-- A report against the draft goes with it (market_reports cascades).
insert into public.market_reports (network, template_id, original_id, reporter_id) values
  ('testnet', 'kpendingaaaaaaaa', 'zpaidlistedaaaaa', '00000000-0000-4000-8000-0000000000e3');

select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000e1' $$,
  'a creator with free, paid and pending templates deletes their account');

select results_eq(
  $$ select creator_id, creator_wallet, status, hidden from public.market_templates where id = 'kfreelistedaaaaa' $$,
  $$ values (null::uuid, 'G' || repeat('K', 55), 'listed'::text, false) $$,
  'the free template stays listed, credited to its wallet');
select results_eq(
  $$ select creator_id, creator_wallet, status, hidden, body from public.market_templates where id = 'kpaidlistedaaaaa' $$,
  $$ values (null::uuid, 'G' || repeat('K', 55), 'listed'::text, true, 'paid body'::text) $$,
  'the paid template is hidden; its listing and body stay (the on-chain listing is not touched)');
select results_eq(
  $$ select status, hidden from public.market_templates where id = 'kpaiddelistedaaa' $$,
  $$ values ('delisted'::text, true) $$,
  'a paid template already delisted is hidden too, should it be listed again on chain');
select is((select count(*)::int from public.market_templates where id = 'kpendingaaaaaaaa'),
  0, 'the draft never confirmed on chain is deleted');
select is((select count(*)::int from public.market_reports where template_id = 'kpendingaaaaaaaa'),
  0, 'with the report against it');
select results_eq(
  $$ select creator_id, hidden from public.market_templates where id = 'zpaidlistedaaaaa' $$,
  $$ values ('00000000-0000-4000-8000-0000000000e3'::uuid, false) $$,
  'another creator''s paid template is not touched');

-- The gallery's read (app/api/market/templates/route.ts), on this file's ids.
select results_eq(
  $$ select t.id from public.market_templates t
      where t.id in ('kfreelistedaaaaa', 'kpaidlistedaaaaa', 'kpaiddelistedaaa', 'kpendingaaaaaaaa', 'zpaidlistedaaaaa')
        and t.network = 'testnet' and t.status = 'listed' and not t.hidden
      order by t.id $$,
  $$ values ('kfreelistedaaaaa'::text), ('zpaidlistedaaaaa'::text) $$,
  'the gallery lists the free one and nothing else of the deleted creator''s');

-- The buyer keeps the purchase.
select results_eq(
  $$ select buyer_id, buyer_wallet, tx_hash from public.market_purchases where template_id = 'kpaidlistedaaaaa' $$,
  $$ values ('00000000-0000-4000-8000-0000000000e2'::uuid, 'G' || repeat('Y', 55), repeat('f', 64)) $$,
  'the buyer''s purchase stays valid');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000e2","role":"authenticated"}';
select results_eq(
  $$ select template_id from public.market_purchases $$,
  $$ values ('kpaidlistedaaaaa'::text) $$,
  'and still sees it as theirs');
reset role;

-- /api/market/claim (service role) serves a purchased template's body
-- whatever its hidden flag; what it reads is still there.
set local role service_role;
select results_eq(
  $$ select title, body, status from public.market_templates where id = 'kpaidlistedaaaaa' and status <> 'pending' $$,
  $$ values ('Paid plan'::text, 'paid body'::text, 'listed'::text) $$,
  'so the buyer can still copy the template they bought');
reset role;

-- A pending row that is referenced anyway is kept rather than refusing the
-- deletion (a restrict on market_purchases or parent_id).
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-0000000000e4', 'odd@example.com', now());
insert into public.market_templates
  (id, network, creator_id, creator_wallet, title, category, body, content_hash, token, price, status) values
  ('opendingaaaaaaaa', 'testnet', '00000000-0000-4000-8000-0000000000e4', 'G' || repeat('Q', 55),
   'Odd draft', 'Work', 'odd body', repeat('a', 64), 'C' || repeat('T', 55), 0, 'pending');
insert into public.market_purchases (network, template_id, buyer_id, buyer_wallet, amount) values
  ('testnet', 'opendingaaaaaaaa', '00000000-0000-4000-8000-0000000000e2', 'G' || repeat('Y', 55), 0);
select lives_ok(
  $$ delete from auth.users where id = '00000000-0000-4000-8000-0000000000e4' $$,
  'a creator whose draft is somehow referenced still deletes their account (the draft is kept)');

select * from finish();
rollback;
