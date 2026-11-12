-- pgTAP tests for 20261112200000_mindmap_share_expiry.sql (WP-4.7, DOQ-54).
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/mindmap_share_expiry.test.sql
--
-- Everything runs in one transaction that is rolled back, so now() is one
-- instant throughout: "expired" is an expiry at or before it, "live" one
-- after it. The send route, the webhook and the status endpoint write and
-- read with the service role; a user is "signed in" by switching to the
-- authenticated role with their id in the JWT claims.
--
-- Cast:
--   ad  admin@example.com  admin of the team workspace "acme"
--
-- Links (all acme):
--   A   hackathon "spring", no expiry yet
--   B   hackathon "spring", an earlier expiry already (kept)
--   C   hackathon "autumn" (another hackathon: untouched)
--   OLD no hackathon: sent before this migration (snapshot 5…0011)
--   OLD2 no hackathon (snapshot 5…0012), never backfilled
--   REV hackathon "spring", revoked
--   EXP hackathon "autumn", already expired

begin;
create extension if not exists pgtap with schema extensions;

select plan(80);

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000001', 'owner@example.com'),
  ('00000000-0000-4000-8000-000000000002', 'admin@example.com');
insert into public.workspaces (id, name, slug, created_by) values
  ('10000000-0000-4000-8000-000000000001', 'Acme', 'acme', '00000000-0000-4000-8000-000000000001');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'admin');

create function pg_temp.sign_in(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

create function pg_temp.share(p_id text, p_token text, p_snapshot text, p_slug text, p_expires timestamptz)
returns void language sql as $$
  insert into public.mindmap_shares (id, token, workspace_id, created_by, snapshot_id, graph, hackathon_slug, expires_at)
  values (p_id::uuid, p_token, '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
          p_snapshot::uuid, '{"nodes": [{"id": "concept:launch", "label": "Launch", "kind": "concept", "depth": 1, "doc_ids": []}], "links": []}',
          p_slug, p_expires);
$$;

create function pg_temp.expires(p_id text) returns timestamptz language sql as $$
  select expires_at from public.mindmap_shares where id = p_id::uuid;
$$;

set local role service_role;
select pg_temp.share('40000000-0000-4000-8000-00000000000a', 'LinkTokenA_0123456789abcdef', '50000000-0000-4000-8000-00000000000a', 'spring', null);
select pg_temp.share('40000000-0000-4000-8000-00000000000b', 'LinkTokenB_0123456789abcdef', '50000000-0000-4000-8000-00000000000b', 'spring', now() + interval '1 hour');
select pg_temp.share('40000000-0000-4000-8000-00000000000c', 'LinkTokenC_0123456789abcdef', '50000000-0000-4000-8000-00000000000c', 'autumn', null);
select pg_temp.share('40000000-0000-4000-8000-000000000011', 'LinkTokenOLD_0123456789abcd', '50000000-0000-4000-8000-000000000011', null, null);
select pg_temp.share('40000000-0000-4000-8000-000000000012', 'LinkTokenOLD2_0123456789abc', '50000000-0000-4000-8000-000000000012', null, null);
select pg_temp.share('40000000-0000-4000-8000-0000000000ae', 'LinkTokenREV_0123456789abcd', '50000000-0000-4000-8000-0000000000ae', 'spring', null);
select pg_temp.share('40000000-0000-4000-8000-0000000000ee', 'LinkTokenEXP_0123456789abcd', '50000000-0000-4000-8000-0000000000ee', 'autumn', now());
update public.mindmap_shares set revoked_at = now() where id = '40000000-0000-4000-8000-0000000000ae';
reset role;

-- ---------------------------------------------------------------------------
-- Schema and privileges
-- ---------------------------------------------------------------------------

select has_column('public', 'mindmap_shares', 'hackathon_slug', 'mindmap_shares.hackathon_slug exists');
select has_column('public', 'mindmap_shares', 'expires_at', 'mindmap_shares.expires_at exists');
select col_is_null('public', 'mindmap_shares', 'hackathon_slug', 'hackathon_slug may be null (links sent before)');
select col_is_null('public', 'mindmap_shares', 'expires_at', 'expires_at may be null (not known yet)');
select throws_ok($$
  insert into public.mindmap_shares (token, workspace_id, snapshot_id, graph, hackathon_slug)
  values ('BadSlugToken_0123456789abcd', '10000000-0000-4000-8000-000000000001', gen_random_uuid(),
          '{"nodes": [], "links": []}', 'Not A Slug')
$$, '23514', null, 'a hackathon_slug outside ^[a-z0-9-]{1,64}$ is refused');
select ok(not has_column_privilege('authenticated', 'public.mindmap_shares', 'expires_at', 'update'),
  'authenticated cannot update expires_at');
select ok(not has_column_privilege('authenticated', 'public.mindmap_shares', 'hackathon_slug', 'update'),
  'nor hackathon_slug');
select ok(has_column_privilege('authenticated', 'public.mindmap_shares', 'revoked_at', 'update'),
  'revoked_at stays updatable (DOQ-53)');
select is((select relrowsecurity from pg_class where oid = 'public.qdit_hackathon_releases'::regclass), true,
  'qdit_hackathon_releases has RLS on');
select ok(not has_table_privilege('anon', 'public.qdit_hackathon_releases', 'select'), 'anon cannot read releases');
select ok(not has_table_privilege('authenticated', 'public.qdit_hackathon_releases', 'select'), 'nor authenticated');
select ok(not has_table_privilege('anon', 'public.rate_limit_hits', 'select'), 'anon cannot read rate_limit_hits');
select ok(not has_table_privilege('authenticated', 'public.rate_limit_hits', 'insert'), 'nor authenticated write it');
select ok(not has_function_privilege('anon', 'public.mindmap_share_statuses(text[])', 'execute'),
  'anon cannot call mindmap_share_statuses (the route rate-limits first)');
select ok(not has_function_privilege('authenticated', 'public.mindmap_share_statuses(text[])', 'execute'), 'nor authenticated');
select ok(has_function_privilege('service_role', 'public.mindmap_share_statuses(text[])', 'execute'), 'the service role can');
select ok(not has_function_privilege('anon', 'public.record_qdit_hackathon_release(uuid, text, timestamptz, timestamptz)', 'execute'),
  'anon cannot record a release');
select ok(not has_function_privilege('authenticated', 'public.record_qdit_hackathon_release(uuid, text, timestamptz, timestamptz)', 'execute'),
  'nor authenticated');
select ok(not has_function_privilege('anon', 'public.consume_rate_limit(text, text, integer, integer, integer)', 'execute'),
  'anon cannot spend a rate limit');
select ok(not has_function_privilege('authenticated', 'public.backfill_mindmap_share_hackathons(jsonb)', 'execute'),
  'authenticated cannot run the backfill');
select ok(has_function_privilege('anon', 'public.mindmap_share(text)', 'execute'), 'anon still calls mindmap_share');
select ok(has_function_privilege('anon', 'public.mindmap_share_live(text)', 'execute'), 'and mindmap_share_live');
select is(
  (select count(*)::int from pg_proc p
    where p.oid in ('public.mindmap_share_statuses(text[])'::regprocedure,
                    'public.record_qdit_hackathon_release(uuid, text, timestamptz, timestamptz)'::regprocedure,
                    'public.consume_rate_limit(text, text, integer, integer, integer)'::regprocedure,
                    'public.backfill_mindmap_share_hackathons(jsonb)'::regprocedure,
                    'public.mindmap_shares_before_insert()'::regprocedure,
                    'public.mindmap_shares_before_update()'::regprocedure,
                    'public.mindmap_share(text)'::regprocedure,
                    'public.mindmap_share_live(text)'::regprocedure)
      and p.proconfig = array['search_path=""']),
  8, 'every new or replaced function has an empty search_path');

-- ---------------------------------------------------------------------------
-- The reads by token: expired is revoked
-- ---------------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select is(public.mindmap_share_live('LinkTokenA_0123456789abcdef'), true, 'no expiry yet: live');
select is(public.mindmap_share_live('LinkTokenB_0123456789abcdef'), true, 'an expiry still ahead: live');
select is(public.mindmap_share_live('LinkTokenEXP_0123456789abcd'), false, 'now() >= expires_at: not live');
select is((select count(*)::int from public.mindmap_share('LinkTokenEXP_0123456789abcd')), 0,
  'and mindmap_share answers nothing for it');
select is((select count(*)::int from public.mindmap_share('LinkTokenB_0123456789abcdef')), 1,
  'while a link with its expiry ahead still answers');
reset role;

-- ---------------------------------------------------------------------------
-- The status batch
-- ---------------------------------------------------------------------------

set local role service_role;
select is(
  (select jsonb_object_agg(token, jsonb_build_object('live', live, 'expires_at', expires_at))
     from public.mindmap_share_statuses(array[
       'LinkTokenA_0123456789abcdef', 'LinkTokenB_0123456789abcdef', 'LinkTokenREV_0123456789abcd',
       'LinkTokenEXP_0123456789abcd', 'UnknownToken_0123456789abcd', 'bad token!', 'LinkTokenA_0123456789abcdef'])),
  jsonb_build_object(
    'LinkTokenA_0123456789abcdef', jsonb_build_object('live', true, 'expires_at', null),
    'LinkTokenB_0123456789abcdef', jsonb_build_object('live', true, 'expires_at', now() + interval '1 hour'),
    'LinkTokenREV_0123456789abcd', jsonb_build_object('live', false, 'expires_at', null),
    'LinkTokenEXP_0123456789abcd', jsonb_build_object('live', false, 'expires_at', null)),
  'one batch: live with and without an expiry, revoked and expired as not live with no expiry; unknown and malformed tokens absent; repeats once');
select is((select count(*)::int from public.mindmap_share_statuses(array[]::text[])), 0, 'an empty batch answers nothing');
select is((select count(*)::int from public.mindmap_share_statuses(null)), 0, 'nor does null');
select lives_ok($$ select * from public.mindmap_share_statuses(array_fill('x'::text, array[500])) $$, '500 tokens are allowed');
select throws_ok($$ select * from public.mindmap_share_statuses(array_fill('x'::text, array[501])) $$,
  '22023', null, '501 are refused');
select is(
  (select proargnames from pg_proc where oid = 'public.mindmap_share_statuses(text[])'::regprocedure),
  array['p_tokens', 'token', 'live', 'expires_at'], 'it answers only token, live and expires_at');
reset role;

-- ---------------------------------------------------------------------------
-- The triggers: set-once hackathon, expiry only earlier
-- ---------------------------------------------------------------------------

set local role service_role;
update public.mindmap_shares set hackathon_slug = 'other' where id = '40000000-0000-4000-8000-00000000000a';
select is((select hackathon_slug from public.mindmap_shares where id = '40000000-0000-4000-8000-00000000000a'), 'spring',
  'a hackathon, once named, is never changed');
update public.mindmap_shares set expires_at = now() + interval '2 hours' where id = '40000000-0000-4000-8000-00000000000b';
select is(pg_temp.expires('40000000-0000-4000-8000-00000000000b'), now() + interval '1 hour', 'an expiry is never moved later');
update public.mindmap_shares set expires_at = null where id = '40000000-0000-4000-8000-00000000000b';
select is(pg_temp.expires('40000000-0000-4000-8000-00000000000b'), now() + interval '1 hour', 'nor cleared');
reset role;

set local role authenticated;
select pg_temp.sign_in('00000000-0000-4000-8000-000000000002');
select throws_ok($$ update public.mindmap_shares set expires_at = null where id = '40000000-0000-4000-8000-0000000000ee' $$,
  '42501', null, 'an admin cannot clear an expiry');
select throws_ok($$ update public.mindmap_shares set hackathon_slug = 'x' where id = '40000000-0000-4000-8000-000000000011' $$,
  '42501', null, 'nor name a hackathon');
select is((select count(*)::int from public.mindmap_shares where hackathon_slug = 'spring'), 3,
  'an admin reads the new columns of their workspace''s links');
reset role;

-- ---------------------------------------------------------------------------
-- hackathon.released
-- ---------------------------------------------------------------------------

set local role service_role;
-- Released two hours ago: links expire 22 hours from now.
select is(
  (select row(outcome, link_expires_at, links_updated)::text
     from public.record_qdit_hackathon_release('60000000-0000-4000-8000-000000000001', 'spring',
                                              now() - interval '2 hours', now() - interval '1 hour')),
  row('applied', now() + interval '22 hours', 2)::text,
  'a release sets every link of the hackathon without an earlier expiry (A and the revoked one)');
select is(pg_temp.expires('40000000-0000-4000-8000-00000000000a'), now() + interval '22 hours', 'A expires released_at + 24 h');
select is(pg_temp.expires('40000000-0000-4000-8000-00000000000b'), now() + interval '1 hour', 'B keeps its earlier expiry');
select is(pg_temp.expires('40000000-0000-4000-8000-00000000000c'), null, 'another hackathon''s link is untouched');
select is(pg_temp.expires('40000000-0000-4000-8000-000000000011'), null, 'so is a link with no hackathon');
select is(
  (select row(event, hackathon_slug, released_at, project_id, processed_at is not null)::text
     from public.qdit_webhook_events where id = '60000000-0000-4000-8000-000000000001'),
  row('hackathon.released', 'spring', now() - interval '2 hours', null::uuid, true)::text,
  'the event is in the webhook''s idempotency store, marked done');
select is(
  (select row(released_at, expires_at, event_id)::text from public.qdit_hackathon_releases where hackathon_slug = 'spring'),
  row(now() - interval '2 hours', now() + interval '22 hours', '60000000-0000-4000-8000-000000000001'::uuid)::text,
  'and the release is kept for the hackathon');

select is(
  (select row(outcome, link_expires_at, links_updated)::text
     from public.record_qdit_hackathon_release('60000000-0000-4000-8000-000000000001', 'spring',
                                              now() + interval '9 days', now())),
  row('duplicate', now() + interval '22 hours', 0)::text,
  'a replay (same id) changes nothing, whatever it says');
select is((select attempts from public.qdit_webhook_events where id = '60000000-0000-4000-8000-000000000001'), 2,
  'and is counted as another delivery');
select is(
  (select row(outcome, link_expires_at, links_updated)::text
     from public.record_qdit_hackathon_release('60000000-0000-4000-8000-000000000002', 'spring',
                                              now() - interval '10 hours', now() - interval '3 hours')),
  row('applied', now() + interval '22 hours', 0)::text,
  'an older event (earlier occurred_at, new id) changes nothing');
select is(
  (select row(outcome, link_expires_at, links_updated)::text
     from public.record_qdit_hackathon_release('60000000-0000-4000-8000-000000000003', 'spring',
                                              now() + interval '3 days', now())),
  row('applied', now() + interval '22 hours', 0)::text,
  'a newer event with a later released_at never extends the expiry');
select is(pg_temp.expires('40000000-0000-4000-8000-00000000000a'), now() + interval '22 hours', 'A still expires at the first time');

-- A link sent after the release is born with the hackathon's expiry.
select pg_temp.share('40000000-0000-4000-8000-0000000000a2', 'LinkTokenA2_0123456789abcde', '50000000-0000-4000-8000-0000000000a2', 'spring', null);
select is(pg_temp.expires('40000000-0000-4000-8000-0000000000a2'), now() + interval '22 hours',
  'a link stored after the release gets the same expiry');

-- Released more than 24 hours ago: autumn's links are dead at once.
select is(
  (select links_updated from public.record_qdit_hackathon_release('60000000-0000-4000-8000-000000000004', 'autumn',
                                              now() - interval '25 hours', now())),
  2, 'autumn''s release reaches C, and brings the already expired link''s later expiry forward');
select is(pg_temp.expires('40000000-0000-4000-8000-0000000000ee'), now() - interval '1 hour', 'to released_at + 24 h, earlier than it had');
reset role;
set local role anon;
select is(public.mindmap_share_live('LinkTokenC_0123456789abcdef'), false, 'a link past released_at + 24 h is not live');
select is((select count(*)::int from public.mindmap_share('LinkTokenC_0123456789abcdef')), 0, 'and its page answers nothing');
reset role;

set local role service_role;
select is(
  (select row(outcome, links_updated)::text
     from public.record_qdit_hackathon_release('60000000-0000-4000-8000-000000000005', 'test-never-sent',
                                              now() - interval '30 days', now())),
  row('applied', 0)::text,
  'a hackathon doqtri sent no link for is answered, with nothing to change (contract step 6)');
select throws_ok($$ select * from public.record_qdit_hackathon_release(gen_random_uuid(), 'Bad Slug', now(), now()) $$,
  '22023', null, 'a malformed hackathon_slug is refused');
select throws_ok($$ select * from public.record_qdit_hackathon_release(gen_random_uuid(), 'spring', null, now()) $$,
  '22023', null, 'so is a missing released_at');
select throws_ok($$
  insert into public.qdit_webhook_events (id, event, occurred_at) values (gen_random_uuid(), 'milestone.status_changed', now())
$$, '23514', null, 'a milestone event still needs its project, milestone and status');
select throws_ok($$
  insert into public.qdit_webhook_events (id, event, occurred_at) values (gen_random_uuid(), 'hackathon.released', now())
$$, '23514', null, 'a release event needs its hackathon and released_at');
reset role;

-- ---------------------------------------------------------------------------
-- The backfill (links sent before this migration)
-- ---------------------------------------------------------------------------

set local role service_role;
select is(
  public.backfill_mindmap_share_hackathons('[
    {"snapshot_id": "50000000-0000-4000-8000-000000000011", "hackathon_slug": "spring"},
    {"snapshot_id": "50000000-0000-4000-8000-00000000000a", "hackathon_slug": "autumn"},
    {"snapshot_id": "59999999-0000-4000-8000-000000000000", "hackathon_slug": "spring"}
  ]'),
  1, 'names the hackathon of the one link that had none; a named link and an unknown snapshot are skipped');
select is((select hackathon_slug from public.mindmap_shares where id = '40000000-0000-4000-8000-000000000011'), 'spring',
  'OLD is now spring''s');
select is(pg_temp.expires('40000000-0000-4000-8000-000000000011'), now() + interval '22 hours',
  'and picks up spring''s known release at once');
select is((select hackathon_slug from public.mindmap_shares where id = '40000000-0000-4000-8000-00000000000a'), 'spring',
  'A keeps its own hackathon');
select is(
  public.backfill_mindmap_share_hackathons('[{"snapshot_id": "50000000-0000-4000-8000-000000000011", "hackathon_slug": "spring"}]'),
  0, 'running it again changes nothing');

-- A hackathon released before qdit sent the event: the operator passes released_at.
select pg_temp.share('40000000-0000-4000-8000-0000000000f1', 'LinkTokenF1_0123456789abcde', '50000000-0000-4000-8000-0000000000f1', 'winter', null);
select is(
  public.backfill_mindmap_share_hackathons('[
    {"snapshot_id": "50000000-0000-4000-8000-000000000012", "hackathon_slug": "winter", "released_at": "2000-01-01T00:00:00Z"}
  ]'),
  1, 'with released_at, the release is recorded as well');
select is(pg_temp.expires('40000000-0000-4000-8000-000000000012'), '2000-01-02T00:00:00Z'::timestamptz,
  'the backfilled link expires released_at + 24 h');
select is(pg_temp.expires('40000000-0000-4000-8000-0000000000f1'), '2000-01-02T00:00:00Z'::timestamptz,
  'and so does a link that already named that hackathon');
select throws_ok($$ select public.backfill_mindmap_share_hackathons('{}') $$, '22023', null, 'it takes only an array');
select is(
  (select count(*)::int from public.mindmap_shares where hackathon_slug is null),
  0, 'every link here now has a hackathon (the report''s query lists those that do not)');
reset role;

-- ---------------------------------------------------------------------------
-- consume_rate_limit
-- ---------------------------------------------------------------------------

set local role service_role;
select is((select allowed from public.consume_rate_limit('link-status', 'clientA', 2, 4)), true, 'a client''s first request is allowed');
select is((select allowed from public.consume_rate_limit('link-status', 'clientA', 2, 4)), true, 'and its second, at the limit');
select is((select allowed from public.consume_rate_limit('link-status', 'clientA', 2, 4)), false, 'the third, past it, is refused');
select is((select refused_by from public.consume_rate_limit('link-status', 'clientA', 2, 4)), 'client', 'refused_by says client');
select ok((select retry_after_seconds between 1 and 60 from public.consume_rate_limit('link-status', 'clientA', 2, 4)),
  'with the seconds until the window ends');
select is(
  (select row(allowed, refused_by)::text from public.consume_rate_limit('link-status', 'clientB', 2, 4)),
  row(false, 'global')::text, 'another client is refused once everyone''s count passes the global limit');
select is((select allowed from public.consume_rate_limit('other-scope', 'clientA', 2, 4)), true, 'scopes count apart');
select throws_ok($$ select * from public.consume_rate_limit('link-status', 'not a hash!', 2, 4) $$, '22023', null,
  'a client key outside [A-Za-z0-9_-] is refused');
reset role;

select * from finish();
rollback;
