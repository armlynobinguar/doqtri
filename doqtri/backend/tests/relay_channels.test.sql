-- pgTAP tests for 20261101100000_relay_channels.sql (WP-4.1, DOQ-3): leases
-- on the channel-account pool never hand one account to two writes, an
-- expired lease can be taken again, a release from a holder who lost the
-- lease changes nothing, and only the service role reaches the table.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/relay_channels.test.sql
--
-- One transaction, rolled back, so now() is fixed: an expired lease is stood
-- in for by moving leased_until into the past. Everything runs in one
-- session, so "at the same moment" here is two leases with nothing released
-- in between. Leases from two sessions at once, which rest on `for update
-- skip locked`, are tested in relay_channels_concurrency.test.sql, which
-- needs a real Postgres with dblink.
--
-- Pool: three testnet channels (0, 1, 2) and one mainnet channel (3).

begin;
create extension if not exists pgtap with schema extensions;

select plan(38);

select has_table('public', 'relay_channels', 'the pool table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.relay_channels'::regclass),
  'with row level security on');
select columns_are('public', 'relay_channels',
  array['idx', 'network', 'public_key', 'leased_until', 'lease_id', 'next_seq'],
  'and public keys and lease state only: no secret column');

insert into public.relay_channels (idx, network, public_key) values
  (0, 'testnet', 'G' || repeat('A', 55)),
  (1, 'testnet', 'G' || repeat('B', 55)),
  (2, 'testnet', 'G' || repeat('C', 55)),
  (3, 'mainnet', 'G' || repeat('D', 55));

select throws_ok($$ insert into public.relay_channels (idx, network, public_key) values (9, 'futurenet', 'G' || repeat('E', 55)) $$,
  '23514', null, 'the network is testnet or mainnet');
select throws_ok($$ insert into public.relay_channels (idx, network, public_key) values (9, 'testnet', 'G' || repeat('A', 55)) $$,
  '23505', null, 'a public key is in the pool once');
select throws_ok($$ insert into public.relay_channels (idx, network, public_key) values (9, 'testnet', 'S' || repeat('A', 55)) $$,
  '23514', null, 'and it is a public key, never a secret seed');


-- ---------------------------------------------------------------------------
-- Leases never share an account
-- ---------------------------------------------------------------------------

set local role service_role;

create temp table leases as select 1 as n, * from public.lease_relay_channel('testnet');
insert into leases select 2, * from public.lease_relay_channel('testnet');
insert into leases select 3, * from public.lease_relay_channel('testnet');

select is((select count(*)::int from leases where idx is not null), 3, 'three leases on three free channels all succeed');
select is((select count(distinct idx)::int from leases), 3, 'and no two return the same channel');
select is((select count(distinct lease_id)::int from leases), 3, 'each with its own lease id');
select ok((select bool_and(idx in (0, 1, 2)) from leases), 'all on the network asked for');
select is((select public_key from leases where idx = 1), 'G' || repeat('B', 55), 'a lease returns the channel''s public key');
select is((select count(*)::int from public.lease_relay_channel('testnet')), 0,
  'a fourth lease while all are held returns no row (the caller waits)');
select ok(
  (select bool_and(c.leased_until = now() + interval '90 seconds' and c.lease_id = l.lease_id)
     from public.relay_channels c join leases l using (idx)),
  'a lease holds its channel for 90 seconds by default');
select is((select count(*)::int from public.lease_relay_channel('mainnet')), 1,
  'the other network''s pool is separate');

select throws_ok($$ select * from public.lease_relay_channel('testnet', interval '60 seconds') $$,
  '22023', null, 'a TTL no longer than the 60 s transaction timeout is refused');
select throws_ok($$ select * from public.lease_relay_channel('testnet', null) $$,
  '22023', null, 'and so is a missing one');


-- ---------------------------------------------------------------------------
-- An expired lease can be leased again
-- ---------------------------------------------------------------------------

reset role;
update public.relay_channels set leased_until = now() - interval '1 second' where idx = 1;
set local role service_role;

create temp table relet as select * from public.lease_relay_channel('testnet');
select is((select idx from relet), 1, 'once its lease runs out, a channel is leased again');
select isnt((select lease_id from relet), (select lease_id from leases where idx = 1),
  'under a new lease id');

-- Of two expired leases, the one that ended first goes first.
reset role;
update public.relay_channels set leased_until = now() - interval '5 seconds' where idx = 2;
update public.relay_channels set leased_until = now() - interval '9 seconds' where idx = 0;
set local role service_role;
select is((select idx from public.lease_relay_channel('testnet')), 0,
  'the channel whose lease ended longest ago is leased first');


-- ---------------------------------------------------------------------------
-- Releasing
-- ---------------------------------------------------------------------------

-- The first holder of channel 1 comes back after its lease expired and was
-- taken: its release must not free the new holder's channel or move next_seq.
select is(public.release_relay_channel(1, (select lease_id from leases where idx = 1), 500),
  false, 'a release with a stale lease id reports it changed nothing');
select results_eq(
  $$ select lease_id, leased_until, next_seq from public.relay_channels where idx = 1 $$,
  $$ select (select lease_id from relet), now() + interval '90 seconds', null::bigint $$,
  'and the new holder keeps its lease, with next_seq untouched');

select is(public.release_relay_channel(1, (select lease_id from relet), 41), true,
  'the current holder releases it');
select results_eq(
  $$ select lease_id, leased_until, next_seq from public.relay_channels where idx = 1 $$,
  $$ values (null::uuid, now(), 41::bigint) $$,
  'which frees the channel, records when its lease ended, and stores its next sequence number');
select is(public.release_relay_channel(1, (select lease_id from relet), 42), false,
  'a second release of the same lease changes nothing');

create temp table again as select * from public.lease_relay_channel('testnet');
-- Channel 2's lease ran out 5 s ago; channel 1 was released just now.
select is((select idx from again), 2,
  'a channel released just now goes behind one that has been free longer, so the pool rotates');
create temp table again1 as select * from public.lease_relay_channel('testnet');
select is((select idx from again1), 1, 'the released channel is leased again');
select is((select next_seq from again1), '41', 'and the lease hands out the stored sequence number');
select is(public.release_relay_channel(1, (select lease_id from again1), null), true,
  'a release without a sequence number');
select is((select next_seq from public.relay_channels where idx = 1), 41::bigint, 'keeps the stored one');
create temp table lower_seq as select * from public.lease_relay_channel('testnet');
select is((select idx from lower_seq), 1, 'with every other testnet channel held, channel 1 is leased once more');
select is(public.release_relay_channel(1, (select lease_id from lower_seq), 7), true,
  'a release with a lower sequence number (its transaction never used the stored one)');
select is((select next_seq from public.relay_channels where idx = 1), 7::bigint,
  'stores it as given, so a floor set too high can be corrected');

-- Sequence numbers run past 2^53; the lease returns them as text, digit for digit.
create temp table big as select * from public.lease_relay_channel('testnet');
select is(public.release_relay_channel((select idx from big), (select lease_id from big), 9007199254740993), true,
  'a sequence number past 2^53 is stored');
select is((select next_seq from public.lease_relay_channel('testnet')), '9007199254740993',
  'and comes back from the lease exactly, as text');


-- ---------------------------------------------------------------------------
-- Who reaches the pool
-- ---------------------------------------------------------------------------

reset role;
set local role anon;
select throws_ok($$ select count(*) from public.relay_channels $$, '42501', null, 'anon cannot read the pool');
select throws_ok($$ select * from public.lease_relay_channel('testnet') $$, '42501', null, 'or lease from it');

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$ select count(*) from public.relay_channels $$, '42501', null, 'a signed-in user cannot read the pool');
select throws_ok($$ select public.release_relay_channel(0, gen_random_uuid(), 1) $$, '42501', null,
  'or release a channel');

reset role;
select * from finish();
rollback;
