-- pgTAP tests for 20261107130000_referral_payouts.sql across sessions (WP-4.6,
-- DOQ-26, AC 4): mark-as-paid calls for the same rewards that really overlap
-- record one payout, and a referrer's deletion at the same moment as a payout
-- doesn't deadlock with it. referral_payouts.test.sql covers everything else, in
-- one session; one session can never be blocked by its own advisory lock.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/referral_payouts_concurrency.test.sql
--
-- As referral_eligibility_concurrency.test.sql: needs a real Postgres with the
-- migrations applied and the dblink extension available, run as a superuser
-- (dblink opens the other sessions back into the same database). PGlite has one
-- session only: there, and wherever dblink is missing, every test is skipped.
-- When dblink needs a host, user or password to connect, pass a libpq connection
-- string in doqtri.test_dsn, e.g.
-- PGOPTIONS='-c doqtri.test_dsn=host=localhost user=postgres password=postgres'.
--
-- The other sessions must see the fixtures, so those rows are committed, not
-- rolled back. Run it against a scratch or local database only: it refuses to
-- start (skips) when referral_rewards or referral_payouts hold any row it didn't
-- put there, and deletes its own rows (users dd000000-…, wallets GDOQTRIPAY…) at
-- the end, also when a test errors.
--
-- The first round uses a gate: one session holds the referrer's lock while the
-- others run up to it, and the test checks they are all waiting there before
-- letting go, so the overlap is certain rather than likely.

create extension if not exists pgtap with schema extensions;

select plan(13);

create function pg_temp.payout_uid(p_n int) returns uuid language sql immutable as $$
  select ('dd000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;

create function pg_temp.payout_wallet(p_n int) returns text language sql immutable as $$
  select 'GDOQTRIPAY' || translate(lpad(p_n::text, 4, '0'), '0123456789', 'ABCDEFGHIJ') || repeat('Q', 42)
$$;

-- Committed through the setup session: a referrer with payout details, and
-- p_from to p_to's eligible rewards, worth 30 each. The admin is user 1.
create function pg_temp.payout_fixture(p_referrer int, p_from int, p_to int) returns void
language plpgsql as $$
begin
  perform dblink_exec('payout_setup', format(
    $q$insert into auth.users (id, email)
       select ('dd000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'payout' || n || '@example.com'
         from (select %s as n union all select generate_series(%s, %s)) u
       on conflict (id) do nothing$q$, p_referrer, p_from, p_to));
  perform dblink_exec('payout_setup', format(
    $q$insert into public.referral_payout_profiles (user_id, method, name, xlm_address)
       values (%L, 'xlm', 'Payout Holder', %L)$q$, pg_temp.payout_uid(p_referrer), pg_temp.payout_wallet(p_referrer)));
  perform dblink_exec('payout_setup', format(
    $q$insert into public.referral_rewards (network, referrer_user_id, referred_user_id, referred_wallet, amount_php, status)
       select 'testnet', %L, ('dd000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
              'GDOQTRIPAY' || translate(lpad(n::text, 4, '0'), '0123456789', 'ABCDEFGHIJ') || repeat('Q', 42), 30, 'eligible'
         from generate_series(%s, %s) n$q$, pg_temp.payout_uid(p_referrer), p_from, p_to));
end;
$$;

-- The call the route makes for all of p_referrer's eligible rewards, as one
-- statement for one session to run, optionally held back until p_at.
create function pg_temp.payout_call(p_referrer int, p_at timestamptz default null) returns text
language sql as $$
  select format(
    $q$select r::text from (select pg_sleep_until(%L::timestamptz)) w,
       lateral (select public.mark_referral_rewards_paid(%L, %L::uuid[], %s, %L::timestamptz, 'tx-hash', %L)) as t(r)$q$,
    coalesce(p_at, now() - interval '1 day'),
    pg_temp.payout_uid(p_referrer),
    (select array_agg(id order by id) from public.referral_rewards
      where referrer_user_id = pg_temp.payout_uid(p_referrer) and status = 'eligible'),
    (select sum(amount_php) from public.referral_rewards
      where referrer_user_id = pg_temp.payout_uid(p_referrer) and status = 'eligible'),
    (select updated_at from public.referral_payout_profiles where user_id = pg_temp.payout_uid(p_referrer)),
    pg_temp.payout_uid(1))
$$;

-- How many sessions are waiting on an advisory lock, once p_expected are, or
-- however many are after five seconds.
create function pg_temp.payout_waiting(p_expected int) returns int language plpgsql as $$
declare
  v_waiting int;
begin
  for attempt in 1 .. 100 loop
    select count(*)::int into v_waiting from pg_locks where locktype = 'advisory' and not granted;
    exit when v_waiting >= p_expected;
    perform pg_sleep(0.05);
  end loop;
  return v_waiting;
end;
$$;

-- What a session's query ended with: null when fine, its error otherwise.
create function pg_temp.payout_result(p_conn text) returns text language plpgsql as $$
begin
  perform * from dblink_get_result(p_conn) as t(r text);
  perform * from dblink_get_result(p_conn) as t(r text);
  return null;
exception when others or query_canceled then
  perform * from dblink_get_result(p_conn, false) as t(r text);
  return sqlerrm;
end;
$$;

-- Every session's error, from 1 to p_count, null for the ones that succeeded.
create function pg_temp.payout_outcomes(p_count int) returns text[] language plpgsql as $$
declare
  v_out text[] := '{}';
begin
  for i in 1 .. p_count loop
    v_out := v_out || pg_temp.payout_result('payout_s' || i);
  end loop;
  return v_out;
end;
$$;

create function pg_temp.payout_count(p_referrer int) returns int language sql as $$
  select count(*)::int from public.referral_payouts where referrer_user_id = pg_temp.payout_uid(p_referrer)
$$;

-- How many of the referrer's rewards are paid, all by one payout of theirs.
create function pg_temp.paid_by_one(p_referrer int) returns int language sql as $$
  select count(*)::int from public.referral_rewards w
    join public.referral_payouts p on p.id = w.payout_id
   where w.referrer_user_id = pg_temp.payout_uid(p_referrer) and w.status = 'paid'
     and p.referrer_user_id = pg_temp.payout_uid(p_referrer)
$$;

create function pg_temp.payout_concurrency_tests() returns setof text
language plpgsql
as $tests$
declare
  dsn text := coalesce(nullif(current_setting('doqtri.test_dsn', true), ''), format('dbname=%L', current_database()));
  sessions constant integer := 8;
  had_dblink boolean;
  starts_at timestamptz;
  outcomes text[];
  others text[];
  deleted text;
  referrer integer;
begin
  if not exists (select 1 from pg_available_extensions where name = 'dblink') then
    return next skip('dblink is not available (PGlite, or a server without contrib): run this against a real Postgres', 13);
    return;
  end if;
  if exists (select 1 from public.referral_rewards where referred_wallet not like 'GDOQTRIPAY%')
     or exists (select 1 from public.referral_payouts) then
    return next skip('the referral tables already hold rows; this test commits rows, so run it against a scratch database', 13);
    return;
  end if;

  had_dblink := exists (select 1 from pg_extension where extname = 'dblink');
  create extension if not exists dblink;

  begin
    perform dblink_connect('payout_setup', dsn);
    perform dblink_connect('payout_gate', dsn);
    perform dblink_exec('payout_gate', 'set role service_role');
    for i in 1 .. sessions loop
      perform dblink_connect('payout_s' || i, dsn);
      perform dblink_exec('payout_s' || i, 'set role service_role');
      perform dblink_exec('payout_s' || i, $$set statement_timeout = '20s'$$);
    end loop;
    perform dblink_connect('payout_del', dsn);
    perform dblink_exec('payout_setup', $$insert into auth.users (id, email) values ('dd000000-0000-4000-8000-000000000001', 'payout-admin@example.com')$$);

    -- Six presses of Mark as paid for the same three rewards, all waiting on the
    -- referrer's lock at once. What each checks must be read after the lock.
    perform pg_temp.payout_fixture(100, 101, 103);
    perform dblink_exec('payout_gate', 'begin');
    perform * from dblink('payout_gate',
      format('select public.lock_referral_referrer(%L)', pg_temp.payout_uid(100))) as t(r text);
    for i in 1 .. 6 loop
      perform dblink_send_query('payout_s' || i, pg_temp.payout_call(100));
    end loop;
    return next is(pg_temp.payout_waiting(6), 6, 'six mark-as-paid calls for the same rewards all wait on the referrer''s lock');
    perform dblink_exec('payout_gate', 'commit');
    outcomes := pg_temp.payout_outcomes(6);
    select coalesce(array_agg(o), '{}') into others from unnest(outcomes) o
     where o is not null and o not like 'These rewards changed%';
    return next is(others, '{}'::text[], 'none fails for any other reason');
    return next is((select count(*)::int from unnest(outcomes) o where o is null), 1,
      'exactly one records the payout; the other five find the rewards paid and are refused');
    return next is(pg_temp.payout_count(100), 1, 'one payout');
    return next is(pg_temp.paid_by_one(100), 3, 'and all three rewards are paid by it');

    -- No gate: eight sessions held back until the same instant.
    perform pg_temp.payout_fixture(200, 201, 202);
    starts_at := clock_timestamp() + interval '1 second';
    for i in 1 .. 8 loop
      perform dblink_send_query('payout_s' || i, pg_temp.payout_call(200, starts_at));
    end loop;
    outcomes := pg_temp.payout_outcomes(8);
    select coalesce(array_agg(o), '{}') into others from unnest(outcomes) o
     where o is not null and o not like 'These rewards changed%';
    return next is(others, '{}'::text[], 'eight calls at the same instant: none fails for any other reason');
    return next is((select count(*)::int from unnest(outcomes) o where o is null), 1, 'one succeeds');
    return next is(pg_temp.payout_count(200), 1, 'so there is one payout');
    return next is(pg_temp.paid_by_one(200), 2, 'paying both rewards');

    -- A referrer's deletion and a payout at the same instant, five times over:
    -- whichever takes the account row first goes first, and nothing deadlocks.
    others := '{}';
    for round in 1 .. 5 loop
      referrer := 300 + round * 10;
      perform pg_temp.payout_fixture(referrer, referrer + 1, referrer + 3);
      starts_at := clock_timestamp() + interval '300 milliseconds';
      perform dblink_send_query('payout_s1', pg_temp.payout_call(referrer, starts_at));
      perform dblink_send_query('payout_del', format(
        $q$with w as (select pg_sleep_until(%L::timestamptz)) delete from auth.users where id = %L and (select true from w)$q$,
        starts_at, pg_temp.payout_uid(referrer)));
      outcomes := pg_temp.payout_outcomes(1);
      deleted := pg_temp.payout_result('payout_del');
      others := others || array(select o from unnest(outcomes) o where o is not null and o not like 'These rewards changed%');
      if deleted is not null then
        others := others || deleted;
      end if;
    end loop;
    return next is(others, '{}'::text[], 'a payout and the referrer''s deletion at once, five times: nothing deadlocks');
    return next is(
      (select count(*)::int from auth.users where id in (select pg_temp.payout_uid(300 + n * 10) from generate_series(1, 5) n)),
      0, 'the accounts are gone');
    return next is(
      (select count(*)::int from public.referral_rewards w
        where w.referred_wallet like 'GDOQTRIPAY%' and w.referrer_user_id is null
          and not (w.status = 'paid' and w.payout_id is not null
                   or w.status = 'void' and w.void_reason = 'referrer_deleted')),
      0, 'each reward ended either paid by a payout, or void because its referrer went');
    return next is(
      (select count(*)::int from public.referral_payouts p
        where p.referrer_user_id is null and p.paid_by = pg_temp.payout_uid(1)
          and p.reward_count <> (select count(*) from public.referral_rewards w where w.payout_id = p.id and w.status = 'paid')),
      0, 'and every payout recorded in those rounds paid all it says it did');
  exception when others or query_canceled then
    perform pg_temp.payout_concurrency_cleanup(had_dblink);
    raise;
  end;

  perform pg_temp.payout_concurrency_cleanup(had_dblink);
end;
$tests$;

-- Closes every session (ending any open transaction, so no lock stays held),
-- then deletes the fixture rows through a session of their own, so the delete is
-- committed even when a test error aborts this one. Drops dblink if this test
-- added it.
create function pg_temp.payout_concurrency_cleanup(had_dblink boolean) returns void
language plpgsql
as $cleanup$
declare
  conn text;
begin
  foreach conn in array coalesce(dblink_get_connections(), '{}') loop
    if conn like 'payout\_%' and conn <> 'payout_setup' then
      perform dblink_disconnect(conn);
    end if;
  end loop;
  if not coalesce('payout_setup' = any(dblink_get_connections()), false) then
    perform dblink_connect('payout_setup', coalesce(nullif(current_setting('doqtri.test_dsn', true), ''), format('dbname=%L', current_database())));
  end if;
  perform dblink_exec('payout_setup', $$delete from public.referral_rewards where referred_wallet like 'GDOQTRIPAY%'$$);
  perform dblink_exec('payout_setup', $$delete from public.referral_payouts
    where paid_by = 'dd000000-0000-4000-8000-000000000001' or referrer_user_id::text like 'dd000000-%'$$);
  perform dblink_exec('payout_setup', $$delete from auth.users where id::text like 'dd000000-%'$$);
  perform dblink_disconnect('payout_setup');
  if not had_dblink then
    drop extension dblink;
  end if;
end;
$cleanup$;

select * from pg_temp.payout_concurrency_tests();

select * from finish();
