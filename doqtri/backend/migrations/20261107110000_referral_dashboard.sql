-- What a referrer's dashboard at /vault/referrals reads (WP-4.6, DOQ-24, D-111).
--
-- One row per person the referrer referred, on one network: their email and
-- wallets for the app to mask, when they were referred and how, how many
-- activities count so far, and their reward, if any. No id, display name, tx
-- hash, referred_wallet or void reason leaves this function, so the route has
-- nothing of the kind to leak. Only lib/referral-dashboard.ts reads it, and it
-- sends the browser masked values only.
--
-- A referred user who deleted their account has no referral or activity left
-- (both cascade), only their reward, which outlives them with referred_user_id
-- null. Those come back as reward-only rows with former_user true and no
-- identity at all: not even the reward's wallet. Their date is when the reward
-- qualified, the only date left, and their activity count is null.
--
-- Activity counts as qualify_referral() counts it: this network, at or after
-- the referral was recorded.
--
-- A reward on another network doesn't show here, and neither does a reward whose
-- referrer isn't p_referrer. Newest first, ties in a fixed order, so reading the
-- result a range at a time can't skip or repeat a row.
--
-- Security definer because it reads auth.users, which the service role can't
-- select, as claim_referral() does. Execute for the service role only: the
-- route passes p_referrer from the verified session. The tables stay service
-- role only, with no policies.

create function public.referral_dashboard(p_referrer uuid, p_network text)
returns table (
  email          text,
  g_wallet       text,
  c_wallet       text,
  referred_at    timestamptz,
  source         text,
  activity_count integer,
  reward_status  text,
  amount_php     integer,
  former_user    boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select x.email, x.g_wallet, x.c_wallet, x.referred_at, x.source,
         x.activity_count, x.reward_status, x.amount_php, x.former_user
    from (
      select u.email::text as email,
             a.address as g_wallet,
             s.address as c_wallet,
             r.created_at as referred_at,
             r.source,
             (select count(*)::integer
                from public.referral_chain_activity c
               where c.user_id = r.referred_user_id
                 and c.network = p_network
                 and c.occurred_at >= r.created_at) as activity_count,
             w.status as reward_status,
             w.amount_php,
             false as former_user,
             r.referred_user_id as tiebreak
        from public.referrals r
        join auth.users u on u.id = r.referred_user_id
        left join public.wallet_accounts a on a.user_id = r.referred_user_id
        left join public.smart_wallets s on s.user_id = r.referred_user_id and s.network = p_network
        left join public.referral_rewards w
          on w.referred_user_id = r.referred_user_id
         and w.referrer_user_id = p_referrer
         and w.network = p_network
       where r.referrer_user_id = p_referrer
      union all
      select null, null, null, w.qualified_at, null, null, w.status, w.amount_php, true, w.id
        from public.referral_rewards w
       where w.referrer_user_id = p_referrer
         and w.network = p_network
         and w.referred_user_id is null
    ) x
   order by x.referred_at desc, x.tiebreak;
$$;

comment on function public.referral_dashboard(uuid, text) is
  'A referrer''s referrals on one network, for the app to mask (DOQ-24, D-111). Service role only.';

revoke execute on function public.referral_dashboard(uuid, text) from public, anon, authenticated;
grant execute on function public.referral_dashboard(uuid, text) to service_role;
