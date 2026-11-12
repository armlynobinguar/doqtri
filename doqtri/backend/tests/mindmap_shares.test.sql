-- pgTAP tests for 20261112100000_mindmap_shares.sql (WP-4.7, DOQ-53).
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/mindmap_shares.test.sql
--
-- Everything runs in one transaction that is rolled back. A user is "signed
-- in" by switching to the authenticated role with their id in the JWT claims;
-- the send route writes with the service role.
--
-- Cast:
--   o   owner@example.com     owner of the team workspace "acme"
--   ad  admin@example.com     admin of acme
--   ed  editor@example.com    editor of acme
--   vw  viewer@example.com    viewer of acme
--   x   outsider@example.com  admin of nothing but their own workspace
--
-- Links: L (acme, live), R (acme, revoked), X (x's personal workspace, live).

begin;
create extension if not exists pgtap with schema extensions;

select plan(46);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'owner@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'admin@example.com'),
  ('00000000-0000-4000-8000-000000000003', 'editor@example.com'),
  ('00000000-0000-4000-8000-000000000004', 'viewer@example.com'),
  ('00000000-0000-4000-8000-000000000005', 'outsider@example.com');

insert into public.workspaces (id, name, slug, created_by) values
  ('10000000-0000-4000-8000-000000000001', 'Acme', 'acme', '00000000-0000-4000-8000-000000000001');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'admin'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'editor'),
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'viewer');

create function pg_temp.sign_in(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

create function pg_temp.graph() returns jsonb language sql as $$
  select '{
    "nodes": [
      {"id": "doc:30000000-0000-4000-8000-000000000001", "label": "Plan", "kind": "document", "depth": 0,
       "doc_ids": ["30000000-0000-4000-8000-000000000001"]},
      {"id": "concept:launch", "label": "Launch", "kind": "concept", "depth": 1,
       "doc_ids": ["30000000-0000-4000-8000-000000000001"]}
    ],
    "links": [{"source": "doc:30000000-0000-4000-8000-000000000001", "target": "concept:launch"}]
  }'::jsonb
$$;

-- The send route's insert, as the service role.
set local role service_role;
insert into public.mindmap_shares (id, token, workspace_id, created_by, snapshot_id, graph, style) values
  ('40000000-0000-4000-8000-000000000001', 'LiveLinkToken_0123456789abcdef', '10000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000001', pg_temp.graph(),
   '{"version": 1, "preset": "aurora"}'),
  ('40000000-0000-4000-8000-000000000002', 'RevokedLinkToken-0123456789ab', '10000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', pg_temp.graph(), null),
  ('40000000-0000-4000-8000-000000000003', 'OutsiderLinkToken_0123456789', (select id from public.workspaces
     where is_personal and created_by = '00000000-0000-4000-8000-000000000005'),
   '00000000-0000-4000-8000-000000000005', '50000000-0000-4000-8000-000000000003', pg_temp.graph(), null);
update public.mindmap_shares set revoked_at = '2000-01-01' where id = '40000000-0000-4000-8000-000000000002';
reset role;

-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select has_table('public', 'mindmap_shares', 'mindmap_shares exists');
select is((select relrowsecurity from pg_class where oid = 'public.mindmap_shares'::regclass), true, 'RLS is on');
select ok(not has_table_privilege('anon', 'public.mindmap_shares', 'select'), 'anon cannot select');
select ok(not has_table_privilege('anon', 'public.mindmap_shares', 'insert'), 'anon cannot insert');
select ok(not has_table_privilege('anon', 'public.mindmap_shares', 'update'), 'anon cannot update');
select ok(not has_table_privilege('anon', 'public.mindmap_shares', 'delete'), 'anon cannot delete');
select ok(has_table_privilege('authenticated', 'public.mindmap_shares', 'select'), 'authenticated may select (RLS decides which)');
select ok(not has_table_privilege('authenticated', 'public.mindmap_shares', 'insert'), 'authenticated cannot insert');
select ok(not has_table_privilege('authenticated', 'public.mindmap_shares', 'delete'), 'authenticated cannot delete');
select ok(has_column_privilege('authenticated', 'public.mindmap_shares', 'revoked_at', 'update'), 'authenticated may update revoked_at');
select ok(not has_column_privilege('authenticated', 'public.mindmap_shares', 'token', 'update'), 'but not the token');
select ok(not has_column_privilege('authenticated', 'public.mindmap_shares', 'graph', 'update'), 'nor the graph');
select is(
  (select array_agg(p.prosecdef order by p.proname) from pg_proc p
    where p.oid in ('public.mindmap_share(text)'::regprocedure, 'public.mindmap_share_live(text)'::regprocedure)),
  array[true, true], 'both reads by token are security definer');
select is(
  (select count(*)::int from pg_proc p
    where p.oid in ('public.mindmap_share(text)'::regprocedure, 'public.mindmap_share_live(text)'::regprocedure,
                    'public.mindmap_shares_before_update()'::regprocedure)
      and p.proconfig = array['search_path=""']),
  3, 'with an empty search_path, as is the trigger');
select ok(has_function_privilege('anon', 'public.mindmap_share(text)', 'execute'), 'anon may call mindmap_share');
select ok(has_function_privilege('anon', 'public.mindmap_share_live(text)', 'execute'), 'and mindmap_share_live');
select ok(not has_function_privilege('authenticated', 'public.mindmap_shares_before_update()', 'execute'),
  'nobody calls the trigger function directly');

select throws_ok($$
  insert into public.mindmap_shares (token, workspace_id, snapshot_id, graph)
  values ('short', '10000000-0000-4000-8000-000000000001', gen_random_uuid(), '{"nodes": [], "links": []}')
$$, '23514', null, 'a token under 22 characters is refused');
select throws_ok($$
  insert into public.mindmap_shares (token, workspace_id, snapshot_id, graph)
  values ('has spaces in it, 0123456789', '10000000-0000-4000-8000-000000000001', gen_random_uuid(), '{"nodes": [], "links": []}')
$$, '23514', null, 'so is one outside base64url');
select throws_ok($$
  insert into public.mindmap_shares (token, workspace_id, snapshot_id, graph)
  values ('AnotherLinkToken_0123456789', '10000000-0000-4000-8000-000000000001', gen_random_uuid(), '{"nodes": {}}')
$$, '23514', null, 'and a graph without node and link arrays');
select throws_ok($$
  insert into public.mindmap_shares (token, workspace_id, snapshot_id, graph)
  values ('AnotherLinkToken_0123456789', '10000000-0000-4000-8000-000000000001',
          '50000000-0000-4000-8000-000000000001', '{"nodes": [], "links": []}')
$$, '23505', null, 'one link per snapshot');
select is((select revoked_at from public.mindmap_shares where id = '40000000-0000-4000-8000-000000000002'), now(),
  'a revocation is stamped now(), whatever time it names');

-- ---------------------------------------------------------------------------
-- Anon: no table, only the reads by token
-- ---------------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select throws_ok($$ select * from public.mindmap_shares $$, '42501', null, 'anon cannot read mindmap_shares directly');
select throws_ok($$ update public.mindmap_shares set revoked_at = now() $$, '42501', null, 'nor revoke');

select is(
  (select graph from public.mindmap_share('LiveLinkToken_0123456789abcdef')),
  '{"nodes": [{"id": "doc:30000000-0000-4000-8000-000000000001", "label": "Plan", "kind": "document", "depth": 0},
              {"id": "concept:launch", "label": "Launch", "kind": "concept", "depth": 1}],
    "links": [{"source": "doc:30000000-0000-4000-8000-000000000001", "target": "concept:launch"}]}'::jsonb,
  'a live link answers its labels, kinds, depths and links, in order, without doc_ids');
select is((select style from public.mindmap_share('LiveLinkToken_0123456789abcdef')),
  '{"version": 1, "preset": "aurora"}'::jsonb, 'and the sender''s style');
select is(
  (select proargnames from pg_proc where oid = 'public.mindmap_share(text)'::regprocedure),
  array['p_token', 'graph', 'style', 'created_at'], 'its only columns are graph, style and created_at');
select is((select count(*)::int from public.mindmap_share('RevokedLinkToken-0123456789ab')), 0, 'a revoked link answers nothing');
select is((select count(*)::int from public.mindmap_share('UnknownLinkToken_0123456789ab')), 0, 'nor does an unknown one');
select is((select count(*)::int from public.mindmap_share('LiveLinkToken_0123456789abcde%')), 0, 'nor a malformed one');
select is((select count(*)::int from public.mindmap_share(null)), 0, 'nor null');
select is(public.mindmap_share_live('LiveLinkToken_0123456789abcdef'), true, 'mindmap_share_live: live');
select is(public.mindmap_share_live('RevokedLinkToken-0123456789ab'), false, 'revoked');
select is(public.mindmap_share_live('UnknownLinkToken_0123456789ab'), false, 'unknown');
reset role;

-- ---------------------------------------------------------------------------
-- Signed in: admins see and revoke their workspace's links, nobody else does
-- ---------------------------------------------------------------------------

set local role authenticated;

select pg_temp.sign_in('00000000-0000-4000-8000-000000000003');
select is((select count(*)::int from public.mindmap_shares), 0, 'an editor sees no links');
update public.mindmap_shares set revoked_at = now() where id = '40000000-0000-4000-8000-000000000001';
select pg_temp.sign_in('00000000-0000-4000-8000-000000000004');
select is((select count(*)::int from public.mindmap_shares), 0, 'nor does a viewer');
update public.mindmap_shares set revoked_at = now() where id = '40000000-0000-4000-8000-000000000001';
select throws_ok($$
  insert into public.mindmap_shares (token, workspace_id, snapshot_id, graph)
  values ('ViewerLinkToken_0123456789ab', '10000000-0000-4000-8000-000000000001', gen_random_uuid(), '{"nodes": [], "links": []}')
$$, '42501', null, 'no client inserts a link');

select pg_temp.sign_in('00000000-0000-4000-8000-000000000005');
select is(
  (select array_agg(id::text) from public.mindmap_shares), array['40000000-0000-4000-8000-000000000003'],
  'an outsider sees only their own workspace''s link');
update public.mindmap_shares set revoked_at = now() where id = '40000000-0000-4000-8000-000000000001';

reset role;
select is((select revoked_at from public.mindmap_shares where id = '40000000-0000-4000-8000-000000000001'), null,
  'none of the editor, the viewer or the outsider revoked L');
set local role authenticated;

select pg_temp.sign_in('00000000-0000-4000-8000-000000000001');
select is((select count(*)::int from public.mindmap_shares), 2, 'the owner sees acme''s two links');
select pg_temp.sign_in('00000000-0000-4000-8000-000000000002');
select is(
  (select array_agg(id::text order by id) from public.mindmap_shares),
  array['40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002'],
  'an admin sees acme''s links, revoked ones included, and not the outsider''s');
select throws_ok($$
  update public.mindmap_shares set token = 'StolenLinkToken_0123456789ab' where id = '40000000-0000-4000-8000-000000000001'
$$, '42501', null, 'an admin cannot change a token');

update public.mindmap_shares set revoked_at = now() where id = '40000000-0000-4000-8000-000000000001';
select isnt((select revoked_at from public.mindmap_shares where id = '40000000-0000-4000-8000-000000000001'), null,
  'an admin revokes L');
update public.mindmap_shares set revoked_at = null where id = '40000000-0000-4000-8000-000000000001';
select isnt((select revoked_at from public.mindmap_shares where id = '40000000-0000-4000-8000-000000000001'), null,
  'and cannot un-revoke it');

reset role;
set local role anon;
select is((select count(*)::int from public.mindmap_share('LiveLinkToken_0123456789abcdef')), 0,
  'once revoked, the page''s read answers nothing at once');
reset role;

-- ---------------------------------------------------------------------------
-- Deletes
-- ---------------------------------------------------------------------------

delete from auth.users where id = '00000000-0000-4000-8000-000000000005';
select is((select count(*)::int from public.mindmap_shares where id = '40000000-0000-4000-8000-000000000003'), 0,
  'a deleted personal workspace takes its links with it');

select * from finish();
rollback;
