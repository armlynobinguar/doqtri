-- Where a referrer's rewards get paid (WP-4.6, DOQ-25, D-112).
--
-- One row per user: their name and either an XLM address, with an optional memo
-- and its type, or e-wallet or bank details. Payouts are manual, so an admin
-- reads this and copies it by hand. An edit applies to future payouts only:
-- nothing here refers to a payout already made, so changing a row can't change
-- one.
--
-- These are financial details, and this is their only copy. Nothing else stores
-- them, and lib/referral-payout-profiles.ts never logs them.
--
-- A row holds one method's details only. The check below refuses the other
-- method's columns, so switching method can't leave the old details behind: the
-- route writes every column on each save, with nulls for the method not chosen.
--
-- The app's validator (lib/referral-payout.ts) is what users meet, with clearer
-- words. These checks are the backstop, and hold whoever writes, the service
-- role included:
--   - no field holds a control or format character (zero-width characters,
--     reordering marks, byte order marks, tags), a line or paragraph separator,
--     or a blank Hangul filler or Braille pattern: referral_payout_text_ok(),
--     with the same ranges as the validator's \p{Cc} and \p{Cf} (Unicode 18);
--   - no field starts or ends with a space;
--   - the name, account name and details hold something visible. The validator
--     asks for a letter or number in any script; that has no portable form in
--     a Postgres regex, whose classes depend on the database's locale, so here
--     it is an ASCII letter or digit, or any other character beyond Latin-1
--     punctuation that isn't a space, a combining mark or a variation selector;
--   - an account number is ASCII letters, digits, spaces and dashes, with at
--     least six digits, so no look-alike digit can stand in for one;
--   - a text memo is printable ASCII, 28 bytes at most, Stellar's limit; an ID
--     memo is an unsigned 64-bit integer in decimal, without leading zeros. A
--     memo always has its type, and a type always has a memo.
--
-- Who may write is the route's rule, since it needs referral_rewards, which only
-- the service role can read: at least one eligible or paid reward on the network.
-- Reading needs only that the row is the owner's, so someone who no longer
-- qualifies can still see what's stored.
--
-- RLS on. The owner can read their own row; no policy allows any write, so writes
-- go through the service role, from the route. anon has no privileges at all.
-- Goes with the account (on delete cascade).

create function public.referral_payout_text_ok(p_text text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_text !~ '[\u0001-\u001F\u007F-\u009F\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u115F\u1160\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\u2800\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0001\U000E0020-\U000E007F]'
     and p_text !~ '^[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]'
     and p_text !~ '[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]$'
$$;

comment on function public.referral_payout_text_ok(text) is
  'No invisible or control characters, and no space at either end: a payout detail is what it looks like (DOQ-25).';

-- Something visible: see the header for how this differs from the validator.
create function public.referral_payout_text_visible(p_text text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_text ~ '[0-9A-Za-z]'
      or p_text ~ '[^\u0001-¿\u1680\u2000-\u200A\u202F\u205F\u3000\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE00-\uFE0F\uFE20-\uFE2F\U000E0100-\U000E01EF]'
$$;

revoke execute on function public.referral_payout_text_ok(text) from public, anon, authenticated;
revoke execute on function public.referral_payout_text_visible(text) from public, anon, authenticated;
-- The checks run them as whoever writes: the service role, from the route.
grant execute on function public.referral_payout_text_ok(text), public.referral_payout_text_visible(text) to service_role;

create table public.referral_payout_profiles (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  method                 text not null check (method in ('xlm', 'ewallet')),
  name                   text not null check (
    char_length(name) between 1 and 100
    and public.referral_payout_text_ok(name) and public.referral_payout_text_visible(name)),
  xlm_address            text check (xlm_address ~ '^G[A-Z2-7]{55}$'),
  xlm_memo               text check (public.referral_payout_text_ok(xlm_memo)),
  xlm_memo_type          text check (xlm_memo_type in ('text', 'id')),
  ewallet_provider       text check (ewallet_provider in ('GCash', 'Maya', 'Bank', 'Other')),
  ewallet_account_name   text check (
    char_length(ewallet_account_name) between 1 and 100
    and public.referral_payout_text_ok(ewallet_account_name)
    and public.referral_payout_text_visible(ewallet_account_name)),
  ewallet_account_number text check (
    char_length(ewallet_account_number) between 1 and 40
    and ewallet_account_number ~ '^[0-9A-Za-z -]+$'
    and public.referral_payout_text_ok(ewallet_account_number)
    and char_length(regexp_replace(ewallet_account_number, '[^0-9]', '', 'g')) >= 6),
  ewallet_details        text check (
    char_length(ewallet_details) between 1 and 200
    and public.referral_payout_text_ok(ewallet_details)
    and public.referral_payout_text_visible(ewallet_details)),
  updated_at             timestamptz not null default now(),
  constraint referral_payout_profiles_memo check (
    (xlm_memo is null) = (xlm_memo_type is null)
    and case xlm_memo_type
      when 'text' then xlm_memo ~ '^[ -~]+$' and octet_length(xlm_memo) <= 28
      -- The cast only once the shape is right: a check's "and" doesn't promise an order.
      when 'id' then case when xlm_memo ~ '^(0|[1-9][0-9]{0,19})$'
                          then xlm_memo::numeric <= 18446744073709551615 else false end
      else true
    end
  ),
  constraint referral_payout_profiles_method_columns check (
    case method
      when 'xlm' then
        xlm_address is not null
        and ewallet_provider is null and ewallet_account_name is null
        and ewallet_account_number is null and ewallet_details is null
      when 'ewallet' then
        ewallet_provider is not null and ewallet_account_name is not null
        and ewallet_account_number is not null
        and xlm_address is null and xlm_memo is null and xlm_memo_type is null
      else false
    end
  )
);

comment on table public.referral_payout_profiles is
  'Where a referrer''s rewards get paid (DOQ-25). The owner can read their own row; writes go through the service role. Never log these values.';
comment on column public.referral_payout_profiles.xlm_memo_type is
  'text or id: exchanges ask for one or the other, and the admin needs to know which to send.';
comment on constraint referral_payout_profiles_method_columns on public.referral_payout_profiles is
  'One method''s details only: switching method clears the other''s.';

alter table public.referral_payout_profiles enable row level security;

create policy "Owners can read their payout profile"
  on public.referral_payout_profiles for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.referral_payout_profiles from public, anon, authenticated;
grant select on public.referral_payout_profiles to authenticated;
grant select, insert, update, delete on public.referral_payout_profiles to service_role;
