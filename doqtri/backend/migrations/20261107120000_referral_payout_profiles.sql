-- Where a referrer's rewards get paid (WP-4.6, DOQ-25, D-112).
--
-- One row per user: their name and either an XLM address, with an optional memo,
-- or e-wallet or bank details. Payouts are manual, so an admin reads this. An
-- edit applies to future payouts only: nothing here refers to a payout already
-- made, so changing a row can't change one.
--
-- These are financial details, and this is their only copy. Nothing else stores
-- them, and lib/referral-payout-profiles.ts never logs them.
--
-- A row holds one method's details only. The check below refuses the other
-- method's columns, so switching method can't leave the old details behind: the
-- route writes every column on each save, with nulls for the method not chosen.
--
-- The app's validator (lib/referral-payout.ts) is what users meet, with the same
-- limits and clearer words. The checks here are what holds if it is ever wrong.
-- Stellar's memo limit is 28 bytes, not characters, hence octet_length.
--
-- Who may write is the route's rule, since it needs referral_rewards, which only
-- the service role can read: at least one eligible or paid reward on the network.
-- Reading needs only that the row is the owner's, so someone who no longer
-- qualifies can still see what's stored.
--
-- RLS on. The owner can read their own row; no policy allows any write, so writes
-- go through the service role, from the route. anon has no privileges at all.
-- Goes with the account (on delete cascade).

create table public.referral_payout_profiles (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  method                 text not null check (method in ('xlm', 'ewallet')),
  name                   text not null check (char_length(name) between 1 and 100 and name !~ '[[:cntrl:]]'),
  xlm_address            text check (xlm_address ~ '^G[A-Z2-7]{55}$'),
  xlm_memo               text check (octet_length(xlm_memo) between 1 and 28 and xlm_memo !~ '[[:cntrl:]]'),
  ewallet_provider       text check (ewallet_provider in ('GCash', 'Maya', 'Bank', 'Other')),
  ewallet_account_name   text check (char_length(ewallet_account_name) between 1 and 100
                                     and ewallet_account_name !~ '[[:cntrl:]]'),
  ewallet_account_number text check (char_length(ewallet_account_number) between 1 and 40
                                     and ewallet_account_number ~ '[0-9]'
                                     and ewallet_account_number !~ '[[:cntrl:]]'),
  ewallet_details        text check (char_length(ewallet_details) between 1 and 200
                                     and ewallet_details !~ '[[:cntrl:]]'),
  updated_at             timestamptz not null default now(),
  constraint referral_payout_profiles_method_columns check (
    case method
      when 'xlm' then
        xlm_address is not null
        and ewallet_provider is null and ewallet_account_name is null
        and ewallet_account_number is null and ewallet_details is null
      when 'ewallet' then
        ewallet_provider is not null and ewallet_account_name is not null
        and ewallet_account_number is not null
        and xlm_address is null and xlm_memo is null
      else false
    end
  )
);

comment on table public.referral_payout_profiles is
  'Where a referrer''s rewards get paid (DOQ-25). The owner can read their own row; writes go through the service role. Never log these values.';
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
