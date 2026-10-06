-- Backfill wallet_accounts for wallet users created before the mapping existed.
--
-- /api/auth/wallet now adopts an existing user only if it is mapped here or
-- carries app_metadata.doqtri_wallet. Wallet users that have not signed in
-- since the mapping table shipped are neither (33 of 37 on 2026-10-07), so
-- their repair path (e.g. after a rotated secret) would be refused.
--
-- Wallet users are recognised by the synthetic email the route gives them:
-- `<lowercased G-address>@stellar.doqtri.local`. Only confirmed users are
-- mapped: the route always creates them confirmed, while an account someone
-- registered at that email through a public sign-up cannot be confirmed
-- (nobody receives mail on that domain).

insert into public.wallet_accounts (address, user_id)
select upper(split_part(u.email, '@', 1)), u.id
  from auth.users u
 where u.email like '%@stellar.doqtri.local'
   and u.email_confirmed_at is not null
   and upper(split_part(u.email, '@', 1)) ~ '^G[A-Z2-7]{55}$'
on conflict do nothing;
