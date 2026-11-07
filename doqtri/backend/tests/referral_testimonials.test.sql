-- pgTAP tests for 20261107140000_referral_testimonials.sql (WP-4.6, DOQ-28,
-- D-113): the owner can read their row and nobody else can, nobody but the
-- service role can write, nothing is public without both consent and approval,
-- the public function returns a name and text and nothing more, an edit or a
-- withdrawal clears approval, and the row goes with the account.
--
--   pg_prove -d "$DATABASE_URL" doqtri/backend/tests/referral_testimonials.test.sql
--
-- One transaction, rolled back. Users are signed in by switching to the
-- authenticated role with their id in the JWT claims (auth.uid()).
--
-- Cast (all with questionnaire names, except n):
--   o  the owner, whose testimonial goes through every state
--   s  someone else, with a testimonial of their own
--   q  private feedback: no consent
--   n  consented, with no questionnaire name: never approved
--   l  consented, and saves a questionnaire name later
--   a  the admin who reviews

begin;
create extension if not exists pgtap with schema extensions;

select plan(112);

create function pg_temp.uid(p_n int) returns uuid language sql immutable as $$
  select ('63000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$$;

insert into auth.users (id, email) values
  (pg_temp.uid(1), 'owner@example.com'),
  (pg_temp.uid(2), 'someone@example.com'),
  (pg_temp.uid(3), 'quiet@example.com'),
  (pg_temp.uid(4), 'nameless@example.com'),
  (pg_temp.uid(9), 'admin@example.com');

insert into public.referral_payout_profiles (user_id, method, name, xlm_address) values
  (pg_temp.uid(1), 'xlm', 'Owner Name', 'G' || repeat('A', 55)),
  (pg_temp.uid(2), 'xlm', 'Someone Else', 'G' || repeat('B', 55)),
  (pg_temp.uid(3), 'xlm', 'Quiet Person', 'G' || repeat('C', 55));

-- The version an admin would have read.
create function pg_temp.version(p_n int) returns timestamptz language sql stable as $$
  select updated_at from public.referral_testimonials where user_id = pg_temp.uid(p_n)
$$;

create function pg_temp.review(p_n int, p_approve boolean) returns text language sql as $$
  select public.referral_testimonial_review(pg_temp.uid(p_n), pg_temp.version(p_n), p_approve, pg_temp.uid(9))
$$;

create function pg_temp.state(p_n int) returns text language sql stable as $$
  select case
           when t.user_id is null then 'none'
           when not t.consent then 'private'
           when t.approved_at is not null then 'approved'
           when t.rejected_at is not null then 'rejected'
           else 'pending'
         end
    from (select 1) one
    left join public.referral_testimonials t on t.user_id = pg_temp.uid(p_n)
$$;

-- ---------------------------------------------------------------------------
-- The table and who may touch it
-- ---------------------------------------------------------------------------

select has_table('public', 'referral_testimonials', 'the table exists');
select col_is_pk('public', 'referral_testimonials', 'user_id', 'one row per user');
select is((select relrowsecurity from pg_class where oid = 'public.referral_testimonials'::regclass),
  true, 'RLS is on');
select policies_are('public', 'referral_testimonials', array['Owners can read their testimonial'],
  'one policy, and it is the owner''s read');
select is(
  (select cmd from pg_policies where schemaname = 'public' and tablename = 'referral_testimonials'),
  'SELECT', 'which is for select only');

select ok(not has_table_privilege('anon', 'public.referral_testimonials', 'select'), 'anon can''t read');
select ok(not has_table_privilege('anon', 'public.referral_testimonials', 'insert, update, delete'), 'nor write');
select ok(not has_table_privilege('authenticated', 'public.referral_testimonials', 'select'),
  'a signed-in user has no table-wide select');
select ok(has_column_privilege('authenticated', 'public.referral_testimonials', 'user_id', 'select')
      and has_column_privilege('authenticated', 'public.referral_testimonials', 'feedback', 'select')
      and has_column_privilege('authenticated', 'public.referral_testimonials', 'consent', 'select')
      and has_column_privilege('authenticated', 'public.referral_testimonials', 'approved_at', 'select')
      and has_column_privilege('authenticated', 'public.referral_testimonials', 'rejected_at', 'select'),
  'only the columns the questionnaire shows its owner, for RLS to filter');
select ok(not has_column_privilege('authenticated', 'public.referral_testimonials', 'approved_by', 'select')
      and not has_column_privilege('authenticated', 'public.referral_testimonials', 'consented_at', 'select')
      and not has_column_privilege('authenticated', 'public.referral_testimonials', 'created_at', 'select')
      and not has_column_privilege('authenticated', 'public.referral_testimonials', 'updated_at', 'select'),
  'not who approved it, nor when it was consented to, made or changed');
select ok(not has_table_privilege('authenticated', 'public.referral_testimonials', 'insert, update, delete'),
  'but not insert, update or delete');
select ok(has_table_privilege('service_role', 'public.referral_testimonials', 'select, insert, update, delete'),
  'the service role can do all four, for the routes');

select is(
  (select string_agg(a.attname::text || ':' || c.confdeltype::text, ',' order by a.attname) collate "default"
     from pg_constraint c
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.conrelid = 'public.referral_testimonials'::regclass and c.contype = 'f'),
  'approved_by:n,user_id:c',
  'the row goes with the account (cascade), and an approver''s id with theirs (set null)');
select ok(not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'referral_testimonials'
       and column_name in ('name', 'method', 'xlm_address', 'ewallet_account_number', 'email')),
  'no payout detail, name or email sits in the table');

select ok(not has_function_privilege('anon', 'public.referral_testimonials_public()', 'execute')
      and not has_function_privilege('authenticated', 'public.referral_testimonials_public()', 'execute'),
  'neither anon nor a signed-in user can call the public read: the server reads it as the service role');
select ok(has_function_privilege('service_role', 'public.referral_testimonials_public()', 'execute'),
  'the service role can');
select ok(not has_function_privilege('anon', 'public.referral_testimonials_for_review()', 'execute')
      and not has_function_privilege('authenticated', 'public.referral_testimonials_for_review()', 'execute')
      and not has_function_privilege('anon', 'public.referral_testimonial_review(uuid, timestamptz, boolean, uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.referral_testimonial_review(uuid, timestamptz, boolean, uuid)', 'execute'),
  'nor the review list or the decision');
select ok(has_function_privilege('service_role', 'public.referral_testimonials_for_review()', 'execute')
      and has_function_privilege('service_role', 'public.referral_testimonial_review(uuid, timestamptz, boolean, uuid)', 'execute'),
  'which the service role can, for the admin routes');
select ok(not has_function_privilege('service_role', 'public.referral_testimonials_before_write()', 'execute')
      and not has_function_privilege('authenticated', 'public.referral_testimonials_before_write()', 'execute')
      and not has_function_privilege('service_role', 'public.referral_payout_profiles_name_changed()', 'execute')
      and not has_function_privilege('authenticated', 'public.referral_payout_profiles_name_changed()', 'execute'),
  'nobody calls the trigger functions');

-- ---------------------------------------------------------------------------
-- Writing, as the route does (the service role)
-- ---------------------------------------------------------------------------

set local role service_role;

select lives_ok(
  $$ insert into public.referral_testimonials (user_id, feedback, consent, consented_at, approved_at, approved_by, rejected_at)
     values ('63000000-0000-4000-8000-000000000001', 'I used Doqtri to map my ideas!', true,
             '2000-01-01', now(), '63000000-0000-4000-8000-000000000009', null) $$,
  'the service role saves the owner''s feedback with consent, and claims an approval it can''t give');
select is(pg_temp.state(1), 'pending', 'a new row is never approved, whatever the writer sent');
select ok((select consented_at > '2000-01-02' from public.referral_testimonials where user_id = pg_temp.uid(1)),
  'and consented_at is the database''s, not the writer''s');

insert into public.referral_testimonials (user_id, feedback, consent) values
  (pg_temp.uid(2), 'Mapping a plan and then proving it shipped is great.', true),
  (pg_temp.uid(3), 'Private thoughts for the team only.', false),
  (pg_temp.uid(4), 'Nameless but approved.', true);
select is((select consented_at from public.referral_testimonials where user_id = pg_temp.uid(3)), null,
  'no consent, no consented_at');

-- The checks, which back the app's validator.
select throws_ok($$ update public.referral_testimonials set feedback = '' where user_id = '63000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'empty feedback is refused: the route deletes the row instead');
select throws_ok($$ update public.referral_testimonials set feedback = repeat('a', 501) where user_id = '63000000-0000-4000-8000-000000000002' $$,
  '23514', null, '501 characters are refused');
select lives_ok($$ update public.referral_testimonials set feedback = repeat(E'\u00E9', 500) where user_id = '63000000-0000-4000-8000-000000000002' $$,
  '500 are fine, counted as characters, not bytes');
select throws_ok($$ update public.referral_testimonials set feedback = E'line one\nline two' where user_id = '63000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'a line break is refused');
select throws_ok($$ update public.referral_testimonials set feedback = E'hidden\u200Bspace' where user_id = '63000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'a zero-width space is refused');
select throws_ok($$ update public.referral_testimonials set feedback = E'abc\u202Edef' where user_id = '63000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'a reordering mark is refused');
select throws_ok($$ update public.referral_testimonials set feedback = ' leading' where user_id = '63000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'a leading space is refused');
select throws_ok($$ update public.referral_testimonials set feedback = '!!! ...' where user_id = '63000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'punctuation alone says nothing, and is refused');
select lives_ok($$ update public.referral_testimonials set feedback = E'\u041E\u0442\u043B\u0438\u0447\u043D\u043E \u2014 \u4F60\u597D \U0001F44D' where user_id = '63000000-0000-4000-8000-000000000002' $$,
  'other scripts and emoji are fine');
update public.referral_testimonials set feedback = 'Mapping a plan and then proving it shipped is great.' where user_id = pg_temp.uid(2);

select throws_ok($$ update public.referral_testimonials set approved_at = now() where user_id = '63000000-0000-4000-8000-000000000003' $$,
  '23514', null, 'feedback without consent can''t be approved, even directly');
select throws_ok($$ update public.referral_testimonials set rejected_at = now() where user_id = '63000000-0000-4000-8000-000000000003' $$,
  '23514', null, 'nor rejected');
select throws_ok($$ update public.referral_testimonials set approved_at = now(), rejected_at = now() where user_id = '63000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'and nothing is approved and rejected at once');
select throws_ok($$ update public.referral_testimonials set approved_by = '63000000-0000-4000-8000-000000000009' where user_id = '63000000-0000-4000-8000-000000000002' $$,
  '23514', null, 'an approver without an approval is refused');

reset role;

-- ---------------------------------------------------------------------------
-- The owner, someone else and anon
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims to '{"sub":"63000000-0000-4000-8000-000000000001","role":"authenticated"}';

select results_eq(
  $$ select user_id, feedback, consent from public.referral_testimonials $$,
  $$ values ('63000000-0000-4000-8000-000000000001'::uuid, 'I used Doqtri to map my ideas!'::text, true) $$,
  'the owner reads their own row, and only that');
select results_eq(
  $$ select feedback, consent, approved_at, rejected_at from public.referral_testimonials $$,
  $$ values ('I used Doqtri to map my ideas!'::text, true, null::timestamptz, null::timestamptz) $$,
  'the owner reads the columns the questionnaire shows');
select throws_ok($$ select approved_by from public.referral_testimonials $$,
  '42501', null, 'but not who approved it');
select throws_ok($$ select * from public.referral_testimonials $$,
  '42501', null, 'nor every column at once');
select throws_ok($$ update public.referral_testimonials set approved_at = now() $$,
  '42501', null, 'the owner can''t approve their own');
select throws_ok($$ update public.referral_testimonials set feedback = 'Changed' $$,
  '42501', null, 'nor change it directly');
select throws_ok($$ delete from public.referral_testimonials $$, '42501', null, 'nor delete it directly');
select throws_ok(
  $$ insert into public.referral_testimonials (user_id, feedback, consent)
     values ('63000000-0000-4000-8000-000000000001', 'Mine', true) $$,
  '42501', null, 'nor insert one');
select throws_ok($$ select * from public.referral_testimonials_public() $$,
  '42501', null, 'nor call the public read');
select throws_ok(
  $$ select public.referral_testimonial_review('63000000-0000-4000-8000-000000000001', now(), true,
                                               '63000000-0000-4000-8000-000000000001') $$,
  '42501', null, 'nor the decision');

set local request.jwt.claims to '{"sub":"63000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*)::int from public.referral_testimonials where user_id = pg_temp.uid(1)), 0,
  'another user can''t read the owner''s row');
select is((select count(*)::int from public.referral_testimonials), 1, 'they see their own only');

set local request.jwt.claims to '';
select is((select count(*)::int from public.referral_testimonials), 0,
  'a signed-in role with no user id reads nothing');
reset role;

set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$ select * from public.referral_testimonials $$, '42501', null, 'anon can''t read the table');
select throws_ok($$ select * from public.referral_testimonials_public() $$, '42501', null, 'nor call the public read');
reset role;

-- ---------------------------------------------------------------------------
-- Review, and what clears it (AC 5)
-- ---------------------------------------------------------------------------

set local role service_role;

select is(pg_temp.review(1, true), 'approved', 'an admin approves the owner''s feedback as they read it');
select results_eq(
  $$ select approved_by, approved_at is not null, rejected_at from public.referral_testimonials
      where user_id = '63000000-0000-4000-8000-000000000001' $$,
  $$ values ('63000000-0000-4000-8000-000000000009'::uuid, true, null::timestamptz) $$,
  'with who approved it');

update public.referral_testimonials set feedback = 'I used Doqtri to map my ideas!', consent = true
 where user_id = pg_temp.uid(1);
select is(pg_temp.state(1), 'approved', 'saving the same text again keeps the approval');

update public.referral_testimonials set feedback = 'I used Doqtri to map my ideas, and more!'
 where user_id = pg_temp.uid(1);
select is(pg_temp.state(1), 'pending', 'editing approved feedback returns it to unapproved (AC 5)');
select is((select approved_by from public.referral_testimonials where user_id = pg_temp.uid(1)), null,
  'and forgets who approved the old text');

select is(
  public.referral_testimonial_review(pg_temp.uid(1), pg_temp.version(1) - interval '1 microsecond', true, pg_temp.uid(9)),
  'changed', 'a decision on a version older than the row''s is refused as changed');
select is(pg_temp.state(1), 'pending', 'and approves nothing');
select is(
  public.referral_testimonial_review(pg_temp.uid(7), now(), true, pg_temp.uid(9)),
  'changed', 'so is one on a testimonial that doesn''t exist');

select is(pg_temp.review(1, true), 'approved', 'approved again, as edited');
update public.referral_testimonials set consent = false where user_id = pg_temp.uid(1);
select is(pg_temp.state(1), 'private', 'withdrawing consent makes it private');
select results_eq(
  $$ select approved_at, approved_by, rejected_at, consented_at from public.referral_testimonials
      where user_id = '63000000-0000-4000-8000-000000000001' $$,
  $$ values (null::timestamptz, null::uuid, null::timestamptz, null::timestamptz) $$,
  'and clears the approval with it');
update public.referral_testimonials set consent = true where user_id = pg_temp.uid(1);
select is(pg_temp.state(1), 'pending', 'consenting again, with the same text, needs a new approval');

select is(pg_temp.review(1, false), 'rejected', 'an admin rejects it');
update public.referral_testimonials set feedback = 'Better words this time.' where user_id = pg_temp.uid(1);
select is(pg_temp.state(1), 'pending', 'an edit after a rejection goes back to review');

select is(pg_temp.review(3, true), 'private', 'private feedback can''t be approved');
select is(pg_temp.review(3, false), 'private', 'nor rejected');
select is(pg_temp.state(3), 'private', 'and stays as it was');

select is(
  public.referral_testimonial_review(pg_temp.uid(1), pg_temp.version(1), true, pg_temp.uid(8)),
  'admin_gone', 'an approver whose account doesn''t exist approves nothing');
select is(pg_temp.state(1), 'pending', 'and the row is unchanged');
select throws_ok(
  $$ select public.referral_testimonial_review('63000000-0000-4000-8000-000000000001', null, true,
                                               '63000000-0000-4000-8000-000000000009') $$,
  '22023', null, 'a missing argument is refused');

-- A new questionnaire name sends it back to review; saving the same name doesn't.
select is(pg_temp.review(1, true), 'approved', 'approved once more');
update public.referral_payout_profiles set name = 'Owner Name' where user_id = pg_temp.uid(1);
select is(pg_temp.state(1), 'approved', 'saving the questionnaire with the same name keeps the approval');
update public.referral_payout_profiles set name = 'Owner Renamed' where user_id = pg_temp.uid(1);
select is(pg_temp.state(1), 'pending', 'a new name needs a new approval: the admin approved the old one');
select is(pg_temp.review(1, true), 'approved', 'which it gets');

select is(pg_temp.review(2, true), 'approved', 'someone else''s is approved too');
select is(pg_temp.review(4, true), 'no_name', 'one with no questionnaire name can''t be approved: there is no name to see');
select is(pg_temp.state(4), 'pending', 'and stays waiting');
select is(pg_temp.review(4, false), 'rejected', 'it can be rejected, which needs no name');
update public.referral_testimonials set feedback = 'Nameless, edited.' where user_id = pg_temp.uid(4);

-- ---------------------------------------------------------------------------
-- A name saved after the fact (the questionnaire's first save is an insert)
-- ---------------------------------------------------------------------------

reset role;
insert into auth.users (id, email) values (pg_temp.uid(5), 'later@example.com');
set local role service_role;
insert into public.referral_testimonials (user_id, feedback, consent) values (pg_temp.uid(5), 'Named later.', true);
create temp table seen as select pg_temp.version(5) as version;
grant select on seen to service_role;

-- Approved some other way (a direct write), with no name yet: still not public.
update public.referral_testimonials set approved_at = now(), approved_by = pg_temp.uid(9) where user_id = pg_temp.uid(5);
select is((select count(*)::int from public.referral_testimonials_public() where feedback = 'Named later.'), 0,
  'an approved row with no name to show isn''t public');
insert into public.referral_payout_profiles (user_id, method, name, xlm_address)
values (pg_temp.uid(5), 'xlm', 'Name Saved Later', 'G' || repeat('E', 55));
select is(pg_temp.state(5), 'pending', 'saving a first questionnaire name clears the approval: nobody approved that name');
select is((select count(*)::int from public.referral_testimonials_public() where feedback = 'Named later.'), 0,
  'so it doesn''t go public under it');
select is(
  public.referral_testimonial_review(pg_temp.uid(5), (select version from seen), true, pg_temp.uid(9)),
  'changed', 'a decision made on the list from before the name was saved is refused as changed');
select is(pg_temp.review(5, true), 'approved', 'approved once the admin has seen the name');
select is((select name from public.referral_testimonials_public() where feedback = 'Named later.'), 'Name Saved Later',
  'and public under that name');

-- A name change moves the version even while unapproved, so a stale list can't approve the new name.
select is(pg_temp.review(5, false), 'rejected', 'rejected');
update seen set version = pg_temp.version(5);
update public.referral_payout_profiles set name = 'Another Name' where user_id = pg_temp.uid(5);
select is(pg_temp.state(5), 'rejected', 'a new name leaves a rejection as it was');
select is(
  public.referral_testimonial_review(pg_temp.uid(5), (select version from seen), true, pg_temp.uid(9)),
  'changed', 'but a decision on the list from before the new name is refused');

select is(pg_temp.review(5, true), 'approved', 'approved under the new name');
delete from public.referral_payout_profiles where user_id = pg_temp.uid(5);
select is(pg_temp.state(5), 'pending', 'removing the questionnaire clears the approval');
select is((select count(*)::int from public.referral_testimonials_public() where feedback = 'Named later.'), 0,
  'and it is off the site');
insert into public.referral_payout_profiles (user_id, method, name, xlm_address)
values (pg_temp.uid(5), 'xlm', 'Another Name', 'G' || repeat('E', 55));
select is(pg_temp.state(5), 'pending', 'and saving it again, even with the same name, needs a new approval');
delete from public.referral_testimonials where user_id = pg_temp.uid(5);
update seen set version = pg_temp.version(2);
update public.referral_testimonials set consent = consent where user_id = pg_temp.uid(2);
select ok(pg_temp.version(2) > (select version from seen),
  'every write is a new, later version, however fast the next one comes');

-- ---------------------------------------------------------------------------
-- The public read (AC 2, AC 3)
-- ---------------------------------------------------------------------------

select is(
  (select array_agg(a order by n) from pg_proc p, unnest(p.proargnames) with ordinality as x(a, n)
    where p.oid = 'public.referral_testimonials_public()'::regprocedure),
  array['name', 'feedback'],
  'the public read returns a name and the text, and no other column (AC 3)');

select set_eq(
  $$ select name, feedback from public.referral_testimonials_public() $$,
  $$ values ('Owner Renamed'::text, 'Better words this time.'::text),
            ('Someone Else'::text, 'Mapping a plan and then proving it shipped is great.'::text) $$,
  'consented and approved only: not private feedback, nor one without a name to show (AC 2)');

update public.referral_testimonials set consent = false where user_id = pg_temp.uid(2);
select set_eq(
  $$ select name from public.referral_testimonials_public() $$,
  $$ values ('Owner Renamed'::text) $$,
  'withdrawing consent takes it off at once (AC 4)');
update public.referral_testimonials set consent = true where user_id = pg_temp.uid(2);
select set_eq(
  $$ select name from public.referral_testimonials_public() $$,
  $$ values ('Owner Renamed'::text) $$,
  'and consenting again doesn''t bring it back without a new approval');
select is(pg_temp.review(2, true), 'approved', 'it is approved again');

update public.referral_testimonials set feedback = 'Edited after approval.' where user_id = pg_temp.uid(2);
select set_eq(
  $$ select name from public.referral_testimonials_public() $$,
  $$ values ('Owner Renamed'::text) $$,
  'an edit hides it until it is approved again (AC 5)');
select is(pg_temp.review(2, true), 'approved', 'it is approved as edited');

select is(pg_temp.review(2, false), 'rejected', 'an approved one can be rejected later');
select set_eq(
  $$ select name from public.referral_testimonials_public() $$,
  $$ values ('Owner Renamed'::text) $$,
  'and leaves the site');
select is(pg_temp.review(2, true), 'approved', 'and approved again');

-- At most 12, newest approval first, in a fixed order.
reset role;
insert into auth.users (id, email)
select pg_temp.uid(100 + n), format('many%s@example.com', n) from generate_series(1, 14) n;
insert into public.referral_payout_profiles (user_id, method, name, xlm_address)
select pg_temp.uid(100 + n), 'xlm', format('Referrer %s', n), 'G' || repeat('D', 55) from generate_series(1, 14) n;
set local role service_role;
insert into public.referral_testimonials (user_id, feedback, consent)
select pg_temp.uid(100 + n), format('Feedback number %s.', n), true from generate_series(1, 14) n;
do $$ begin
  for n in 1..14 loop
    perform pg_temp.review(100 + n, true);
  end loop;
end $$;
-- A minute apart, so the order doesn't depend on the clock's resolution.
update public.referral_testimonials t set approved_at = clock_timestamp() + (n * interval '1 minute')
  from generate_series(1, 14) n where t.user_id = pg_temp.uid(100 + n);

select is((select count(*)::int from public.referral_testimonials_public()), 12, 'at most 12 are shown');
select results_eq(
  $$ select name from public.referral_testimonials_public() limit 3 $$,
  $$ values ('Referrer 14'::text), ('Referrer 13'::text), ('Referrer 12'::text) $$,
  'newest approval first');
select results_eq(
  $$ select name, feedback from public.referral_testimonials_public() $$,
  $$ select name, feedback from public.referral_testimonials_public() $$,
  'in the same order every time');

-- The admin list has everyone, private feedback included, waiting for review first.
update public.referral_testimonials set feedback = 'Waiting now.' where user_id = pg_temp.uid(101);
select is(
  (select user_id from public.referral_testimonials_for_review() limit 1), pg_temp.uid(101),
  'the review list puts what''s waiting first');
select is(
  (select array_agg(user_id order by user_id) from public.referral_testimonials_for_review()
    where user_id in (pg_temp.uid(3), pg_temp.uid(4))),
  array[pg_temp.uid(3), pg_temp.uid(4)],
  'and lists private and nameless feedback for admins to read');
select is(
  (select name from public.referral_testimonials_for_review() where user_id = pg_temp.uid(4)), null,
  'with no name where there is none');

reset role;

-- ---------------------------------------------------------------------------
-- The account goes, and the testimonial with it (AC 4)
-- ---------------------------------------------------------------------------

delete from auth.users where id = pg_temp.uid(1);
select is((select count(*)::int from public.referral_testimonials where user_id = pg_temp.uid(1)), 0,
  'deleting the account deletes its testimonial');
set local role service_role;
select is((select count(*)::int from public.referral_testimonials_public() where name = 'Owner Renamed'), 0,
  'and it is off the site');
reset role;

delete from auth.users where id = pg_temp.uid(9);
select results_eq(
  $$ select approved_by, approved_at is not null from public.referral_testimonials
      where user_id = '63000000-0000-4000-8000-000000000002' $$,
  $$ values (null::uuid, true) $$,
  'deleting the approving admin''s account forgets who approved, and the approval stands');

select * from finish();
rollback;
