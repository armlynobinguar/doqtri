-- pgTAP tests for 20261107100000_referral_eligibility.sql across sessions
-- (WP-4.6, DOQ-23, AC 6): qualifications that really overlap can't pass a
-- referrer's limit, give one referral two rewards or miss a reward, and an
-- account deletion can't deadlock with a void's promotion.
-- referral_eligibility.test.sql covers everything else, in one session; one
-- session can never be blocked by its own advisory lock.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/referral_eligibility_concurrency.test.sql
--
-- Needs a real Postgres with the migrations applied and the dblink
-- extension available, run as a superuser (dblink opens the other sessions
-- back into the same database). PGlite has one session only: there, and
-- wherever dblink is missing, every test is skipped. dblink connects with
-- `dbname=<this database>` over the server's local socket; when that needs
-- a host, user or password, pass a libpq connection string in
-- doqtri.test_dsn, e.g. PGOPTIONS='-c doqtri.test_dsn=host=localhost user=postgres password=postgres'.
--
-- The other sessions must see the fixtures, so those rows are committed, not
-- rolled back. Run it against a scratch or local database only: it refuses to
-- start (skips) when referral_rewards holds any row it didn't put there, and
-- deletes its own rows (users cc000000-…, wallets GDOQTRITEST…) at the end,
-- also when a test errors.
--
-- The first rounds use a gate: one session holds the referrer's lock while the others
-- run up to it, and the test checks they are all waiting there before letting
-- go. So the overlap is certain rather than likely, and anything a function
-- reads before taking the lock is stale by the time it gets it. The rules here
-- are the test's own, passed as arguments as the app passes its.

create extension if not exists pgtap with schema extensions;

select plan(17);

create function pg_temp.referral_uid(p_n int) returns uuid language sql immutable as $$
  select ('cc000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;

create function pg_temp.referral_wallet(p_n int) returns text language sql immutable as $$
  select 'GDOQTRITEST' || translate(lpad(p_n::text, 4, '0'), '0123456789', 'ABCDEFGHIJ') || repeat('Q', 41)
$$;

create function pg_temp.referral_tx(p_n int) returns text language sql immutable as $$
  select lpad(to_hex(p_n), 64, 'f')
$$;

-- p_user's next call, as one statement for one session to run.
create function pg_temp.referral_call(p_user int, p_tx int, p_limit int) returns text language sql immutable as $$
  select format($q$select public.record_referral_activity(%L, 'testnet', %L, %L, 'anchor', now(), 3, 30, %s)$q$,
                pg_temp.referral_uid(p_user), pg_temp.referral_tx(p_tx), pg_temp.referral_wallet(p_user), p_limit)
$$;

-- Committed through the setup session: a referrer, and users it referred an
-- hour ago, each with p_prior calls already behind them.
create function pg_temp.referral_fixture(p_referrer int, p_from int, p_to int, p_prior int, p_limit int) returns void
language plpgsql as $$
begin
  perform dblink_exec('referral_setup', format(
    $q$insert into auth.users (id, email)
       select ('cc000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'referral' || n || '@example.com'
         from (select %s as n union all select generate_series(%s, %s)) u$q$, p_referrer, p_from, p_to));
  perform dblink_exec('referral_setup', format(
    $q$insert into public.referrals (referred_user_id, referrer_user_id, code, created_at)
       select ('cc000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, %L, 'abcdefgh', now() - interval '1 hour'
         from generate_series(%s, %s) n$q$, pg_temp.referral_uid(p_referrer), p_from, p_to));
  for n in p_from .. p_to loop
    for k in 1 .. p_prior loop
      perform * from dblink('referral_setup', pg_temp.referral_call(n, n * 10 + k, p_limit)) as t(r text);
    end loop;
  end loop;
end;
$$;

-- Holds the referrer's lock in a transaction of its own, until the gate opens.
create function pg_temp.referral_close_gate(p_referrer int) returns void language plpgsql as $$
begin
  perform dblink_exec('referral_gate', 'begin');
  perform * from dblink('referral_gate',
    format('select public.lock_referral_referrer(%L)', pg_temp.referral_uid(p_referrer))) as t(r text);
end;
$$;

-- How many sessions are waiting on an advisory lock, once p_expected are, or
-- however many are after five seconds.
create function pg_temp.referral_waiting(p_expected int) returns int language plpgsql as $$
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

-- What a session's query ended with: null when fine, its error otherwise. Reads
-- its result, then the empty one dblink needs read before the next query.
create function pg_temp.referral_result(p_conn text) returns text language plpgsql as $$
begin
  perform * from dblink_get_result(p_conn) as t(r text);
  perform * from dblink_get_result(p_conn) as t(r text);
  return null;
exception when others or query_canceled then
  perform * from dblink_get_result(p_conn, false) as t(r text);
  return sqlerrm;
end;
$$;

-- The errors from sessions 1 to p_count; empty when none failed.
create function pg_temp.referral_errors(p_count int) returns text[] language plpgsql as $$
declare
  v_errors text[] := '{}';
  v_error text;
begin
  for i in 1 .. p_count loop
    v_error := pg_temp.referral_result('referral_s' || i);
    if v_error is not null then
      v_errors := v_errors || v_error;
    end if;
  end loop;
  return v_errors;
end;
$$;

-- A referrer's rewards by status, as text, so a test reads the whole split.
create function pg_temp.referral_split(p_referrer int) returns text language sql as $$
  select coalesce(string_agg(status || '=' || n, ' ' order by status), '')
    from (select status, count(*) n from public.referral_rewards
           where referrer_user_id = pg_temp.referral_uid(p_referrer) group by status) s
$$;

create function pg_temp.referral_concurrency_tests() returns setof text
language plpgsql
as $tests$
declare
  dsn text := coalesce(nullif(current_setting('doqtri.test_dsn', true), ''), format('dbname=%L', current_database()));
  sessions constant integer := 12;
  had_dblink boolean;
  starts_at timestamptz;
  held_error text;
  errors text[];
  deleted text;
  referrer integer;
begin
  if not exists (select 1 from pg_available_extensions where name = 'dblink') then
    return next skip('dblink is not available (PGlite, or a server without contrib): run this against a real Postgres', 17);
    return;
  end if;
  if exists (select 1 from public.referral_rewards where referred_wallet not like 'GDOQTRITEST%') then
    return next skip('referral_rewards already holds real rewards; this test commits rows, so run it against a scratch database', 17);
    return;
  end if;

  had_dblink := exists (select 1 from pg_extension where extname = 'dblink');
  create extension if not exists dblink;

  begin
    perform dblink_connect('referral_setup', dsn);
    perform dblink_connect('referral_gate', dsn);
    perform dblink_exec('referral_gate', 'set role service_role');
    for i in 1 .. sessions loop
      perform dblink_connect('referral_s' || i, dsn);
      perform dblink_exec('referral_s' || i, 'set role service_role');
      perform dblink_exec('referral_s' || i, $$set statement_timeout = '20s'$$);
    end loop;
    perform dblink_connect('referral_del', dsn);

    -- Eight users cross the threshold at once, with three places. Status is
    -- decided from the places left, which must be read under the lock.
    perform pg_temp.referral_fixture(100, 101, 108, 2, 3);
    perform pg_temp.referral_close_gate(100);
    for i in 1 .. 8 loop
      perform dblink_send_query('referral_s' || i, pg_temp.referral_call(100 + i, 100000 + i, 3));
    end loop;
    return next is(pg_temp.referral_waiting(8), 8, 'eight qualifications are all waiting on the referrer''s lock at once');
    perform dblink_exec('referral_gate', 'commit');
    return next is(pg_temp.referral_errors(8), '{}'::text[], 'and all finish');
    return next is(pg_temp.referral_split(100), 'eligible=3 over_limit=5',
      'three places: three eligible, and the other five over the limit');

    -- Two calls at once take a user from 1 to 3. Each can see only its own call
    -- until the other commits, so the second must count after the lock, or both
    -- see 2 and the reward is missed.
    perform pg_temp.referral_fixture(200, 201, 201, 1, 30);
    perform pg_temp.referral_close_gate(200);
    perform dblink_send_query('referral_s1', pg_temp.referral_call(201, 200001, 30));
    perform dblink_send_query('referral_s2', pg_temp.referral_call(201, 200002, 30));
    return next is(pg_temp.referral_waiting(2), 2, 'two calls taking one user to the threshold both wait on the lock');
    perform dblink_exec('referral_gate', 'commit');
    return next is(pg_temp.referral_errors(2), '{}'::text[], 'and both finish');
    return next is(pg_temp.referral_split(200), 'eligible=1', 'the reward isn''t missed');

    -- One user, many calls: new transactions, a sync, and one transaction twice
    -- (that one waits on the other's row, not the lock, so isn't counted waiting).
    perform pg_temp.referral_fixture(300, 301, 301, 2, 30);
    perform pg_temp.referral_close_gate(300);
    for i in 1 .. 5 loop
      perform dblink_send_query('referral_s' || i, pg_temp.referral_call(301, 300000 + i, 30));
    end loop;
    perform dblink_send_query('referral_s6',
      format($q$select public.settle_referral_activity(%L, 'testnet', 3, 30, 30)$q$, pg_temp.referral_uid(301)));
    return next is(pg_temp.referral_waiting(6), 6, 'six calls for one user all wait on the lock');
    perform dblink_send_query('referral_s7', pg_temp.referral_call(301, 300001, 30));
    perform dblink_exec('referral_gate', 'commit');
    return next is(pg_temp.referral_errors(7), '{}'::text[], 'and all finish, the repeated transaction too');
    return next is(pg_temp.referral_split(300), 'eligible=1', 'one referral gets one reward');
    return next is(
      (select count(*)::int from public.referral_chain_activity where user_id = pg_temp.referral_uid(301)),
      7, 'and the transaction seen twice counts once');

    -- No gate: ten sessions held back until the same instant, four places.
    perform pg_temp.referral_fixture(400, 401, 410, 2, 4);
    starts_at := clock_timestamp() + interval '1 second';
    for i in 1 .. 10 loop
      perform dblink_send_query('referral_s' || i, format('select r from (select pg_sleep_until(%L::timestamptz)) w, lateral (%s) as t(r)',
        starts_at, pg_temp.referral_call(400 + i, 400000 + i, 4)));
    end loop;
    return next is(pg_temp.referral_errors(10), '{}'::text[], 'ten sessions at the same instant all finish');
    return next is(pg_temp.referral_split(400), 'eligible=4 over_limit=6', 'and four places hold');

    -- A promotion never waits on a row someone else holds: waiting there while
    -- holding the voided row is half of a deadlock with a deletion's set null.
    -- With one over-limit reward held, a void finishes, and the next one moves up.
    perform pg_temp.referral_fixture(500, 501, 505, 3, 2);
    perform dblink_exec('referral_gate', 'begin');
    perform * from dblink('referral_gate', format(
      $q$select id from public.referral_rewards where referred_user_id = %L for update$q$,
      pg_temp.referral_uid(503))) as t(r text);
    perform dblink_exec('referral_s1', $$set statement_timeout = '3s'$$);
    held_error := null;
    begin
      perform * from dblink('referral_s1', format(
        $q$select public.void_referral_reward(
             (select id from public.referral_rewards where referred_user_id = %L), 'fraud', 2)$q$,
        pg_temp.referral_uid(501))) as t(r text);
    exception when others or query_canceled then
      -- query_canceled (the statement timeout) is not among "others".
      held_error := sqlerrm;
    end;
    perform dblink_exec('referral_gate', 'commit');
    perform dblink_exec('referral_s1', $$set statement_timeout = '20s'$$);
    return next is(held_error, null, 'a void finishes though the oldest over-limit reward is held by another transaction');
    return next is(pg_temp.referral_split(500), 'eligible=2 over_limit=2 void=1', 'and the next oldest takes the place');

    -- A referrer's deletion and voids at once, five times over. Without the
    -- rule above, a deletion or a void loses to a deadlock some of the time.
    errors := '{}';
    for round in 1 .. 5 loop
      referrer := 600 + round * 100;
      perform pg_temp.referral_fixture(referrer, referrer + 1, referrer + 30, 3, 10);
      starts_at := clock_timestamp() + interval '300 milliseconds';
      for i in 1 .. 11 loop
        perform dblink_send_query('referral_s' || i, format(
          $q$select r from (select pg_sleep_until(%L::timestamptz)) w, lateral (select public.void_referral_reward(
               (select id from public.referral_rewards where referred_user_id = %L), 'fraud', 10)) as t(r)$q$,
          starts_at, pg_temp.referral_uid(referrer + i)));
      end loop;
      perform dblink_send_query('referral_del', format(
        $q$with w as (select pg_sleep_until(%L::timestamptz)) delete from auth.users where id = %L and (select true from w)$q$,
        starts_at, pg_temp.referral_uid(referrer)));
      errors := errors || pg_temp.referral_errors(11);
      deleted := pg_temp.referral_result('referral_del');
      if deleted is not null then
        errors := errors || deleted;
      end if;
    end loop;
    return next is(errors, '{}'::text[], 'a referrer''s deletion and eleven voids, five times: nothing deadlocks');
    return next is(
      (select count(*)::int from auth.users where id in (select pg_temp.referral_uid(600 + n * 100) from generate_series(1, 5) n)),
      0, 'the accounts are gone');
    return next is(
      (select count(*)::int from public.referral_rewards w
        where w.referred_wallet like 'GDOQTRITEST%' and w.referrer_user_id is null and w.status in ('eligible', 'over_limit')),
      0, 'and no unpaid reward outlives its referrer');
  exception when others or query_canceled then
    perform pg_temp.referral_concurrency_cleanup(had_dblink);
    raise;
  end;

  perform pg_temp.referral_concurrency_cleanup(had_dblink);
end;
$tests$;

-- Closes every session (ending any open transaction, so no lock stays held),
-- then deletes the fixture rows through a session of their own, so the delete is
-- committed even when a test error aborts this one. Drops dblink if this test
-- added it.
create function pg_temp.referral_concurrency_cleanup(had_dblink boolean) returns void
language plpgsql
as $cleanup$
declare
  conn text;
begin
  foreach conn in array coalesce(dblink_get_connections(), '{}') loop
    if conn like 'referral\_%' and conn <> 'referral_setup' then
      perform dblink_disconnect(conn);
    end if;
  end loop;
  if not coalesce('referral_setup' = any(dblink_get_connections()), false) then
    perform dblink_connect('referral_setup', coalesce(nullif(current_setting('doqtri.test_dsn', true), ''), format('dbname=%L', current_database())));
  end if;
  perform dblink_exec('referral_setup', $$delete from public.referral_rewards where referred_wallet like 'GDOQTRITEST%'$$);
  perform dblink_exec('referral_setup', $$delete from auth.users where id::text like 'cc000000-%'$$);
  perform dblink_disconnect('referral_setup');
  if not had_dblink then
    drop extension dblink;
  end if;
end;
$cleanup$;

select * from pg_temp.referral_concurrency_tests();

select * from finish();
