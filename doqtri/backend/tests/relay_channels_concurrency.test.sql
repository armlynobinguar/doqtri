-- pgTAP tests for 20261101100000_relay_channels.sql across sessions (WP-4.1,
-- DOQ-3): two requests leasing at the same moment never get the same channel
-- account. relay_channels.test.sql covers everything else, in one session;
-- one session can never be blocked by its own row locks, so it can't show
-- what `for update skip locked` does when two leases really overlap.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/relay_channels_concurrency.test.sql
--
-- Needs a real Postgres with the migrations applied and the dblink
-- extension available, run as a superuser (dblink opens the other sessions
-- back into the same database). PGlite has one session only: there, and
-- wherever dblink is missing, every test is skipped. dblink connects with
-- `dbname=<this database>` over the server's local socket; when that needs
-- a host, user or password, pass a libpq connection string in
-- doqtri.test_dsn, e.g. PGOPTIONS='-c doqtri.test_dsn=host=localhost user=postgres password=postgres'.
--
-- The other sessions must see the pool, so the fixture rows are committed,
-- not rolled back. Run it against a scratch or local database only: it
-- refuses to start (skips) when relay_channels holds any row it didn't put
-- there, and deletes its own rows (public keys starting GDOQTRITEST) at the
-- end, also when a test errors.
--
-- Pool: 40 testnet channels, as the seed script makes.

create extension if not exists pgtap with schema extensions;

select plan(5);

create function pg_temp.relay_channel_concurrency_tests() returns setof text
language plpgsql
as $tests$
declare
  dsn text := coalesce(nullif(current_setting('doqtri.test_dsn', true), ''), format('dbname=%L', current_database()));
  lease_sql constant text := $$select idx from public.lease_relay_channel('testnet')$$;
  had_dblink boolean;
  first_idx integer;
  second_idx integer;
  second_error text;
  waited interval;
  started timestamptz;
  sessions constant integer := 45;
  leased integer[] := '{}';
  got integer;
begin
  if not exists (select 1 from pg_available_extensions where name = 'dblink') then
    return next skip('dblink is not available (PGlite, or a server without contrib): run this against a real Postgres', 5);
    return;
  end if;
  if exists (select 1 from public.relay_channels where public_key not like 'GDOQTRITEST%') then
    return next skip('relay_channels already holds a real pool; this test commits rows, so run it against a scratch database', 5);
    return;
  end if;

  had_dblink := exists (select 1 from pg_extension where extname = 'dblink');
  create extension if not exists dblink;

  begin
    -- Committed through a session of its own, so the leasing sessions see it.
    perform dblink_connect('relay_setup', dsn);
    perform dblink_exec('relay_setup', $$delete from public.relay_channels where public_key like 'GDOQTRITEST%'$$);
    perform dblink_exec('relay_setup', $$
      insert into public.relay_channels (idx, network, public_key)
      select g, 'testnet', 'GDOQTRITEST' || translate(lpad(g::text, 3, '0'), '0123456789', 'ABCDEFGHIJ') || repeat('Q', 42)
        from generate_series(0, 39) g
    $$);

    -- Two sessions. A leases inside a transaction it keeps open, so its row
    -- lock is still held when B leases. B must neither wait for A nor get
    -- A's channel; without `skip locked` it would block until its timeout.
    perform dblink_connect('relay_a', dsn);
    perform dblink_connect('relay_b', dsn);
    perform dblink_exec('relay_a', 'set role service_role');
    perform dblink_exec('relay_b', 'set role service_role');
    perform dblink_exec('relay_b', $$set statement_timeout = '5s'$$);
    perform dblink_exec('relay_a', 'begin');
    select t.idx into first_idx from dblink('relay_a', lease_sql) as t(idx integer);
    started := clock_timestamp();
    begin
      select t.idx into second_idx from dblink('relay_b', lease_sql) as t(idx integer);
    exception when others or query_canceled then
      -- query_canceled (B's statement timeout) is not among "others".
      second_error := sqlerrm;
    end;
    waited := clock_timestamp() - started;
    perform dblink_exec('relay_a', 'commit');

    return next ok(first_idx is not null and second_idx is not null,
      'two sessions both lease a channel while the first lease is uncommitted'
        || coalesce(' (the second failed: ' || second_error || ')', ''));
    return next isnt(second_idx, first_idx, 'and they get different channels');
    return next cmp_ok(waited, '<', interval '2 seconds', 'without the second waiting on the first''s lock');

    -- Many sessions at once: 45 leases on 40 free channels, each sent
    -- asynchronously and held back until the same instant.
    perform dblink_exec('relay_setup', $$update public.relay_channels set lease_id = null, leased_until = null where public_key like 'GDOQTRITEST%'$$);
    started := clock_timestamp() + interval '1 second';
    for i in 1 .. sessions loop
      perform dblink_connect('relay_c' || i, dsn);
      perform dblink_exec('relay_c' || i, 'set role service_role');
    end loop;
    for i in 1 .. sessions loop
      perform dblink_send_query('relay_c' || i, format(
        $$select (public.lease_relay_channel('testnet')).idx from (select pg_sleep_until(%L::timestamptz)) wait$$, started));
    end loop;
    for i in 1 .. sessions loop
      for got in select t.idx from dblink_get_result('relay_c' || i) as t(idx integer) loop
        leased := leased || got;
      end loop;
    end loop;

    return next is(cardinality(leased), 40, '45 sessions leasing at once from 40 free channels: 40 get one, 5 get none');
    return next is((select count(distinct l)::integer from unnest(leased) l), 40, 'and no two get the same channel');
  exception when others or query_canceled then
    perform pg_temp.relay_channel_concurrency_cleanup(had_dblink);
    raise;
  end;

  perform pg_temp.relay_channel_concurrency_cleanup(had_dblink);
end;
$tests$;

-- Closes every leasing session (ending any open transaction, so no row
-- stays locked), then deletes the fixture rows through the setup session, so
-- the delete is committed even when a test error aborts this one. Drops
-- dblink if this test added it.
create function pg_temp.relay_channel_concurrency_cleanup(had_dblink boolean) returns void
language plpgsql
as $cleanup$
declare
  conn text;
begin
  foreach conn in array coalesce(dblink_get_connections(), '{}') loop
    if conn like 'relay\_%' and conn <> 'relay_setup' then
      perform dblink_disconnect(conn);
    end if;
  end loop;
  if not coalesce('relay_setup' = any(dblink_get_connections()), false) then
    perform dblink_connect('relay_setup', coalesce(nullif(current_setting('doqtri.test_dsn', true), ''), format('dbname=%L', current_database())));
  end if;
  perform dblink_exec('relay_setup', $$delete from public.relay_channels where public_key like 'GDOQTRITEST%'$$);
  perform dblink_disconnect('relay_setup');
  if not had_dblink then
    drop extension dblink;
  end if;
end;
$cleanup$;

select * from pg_temp.relay_channel_concurrency_tests();

select * from finish();
