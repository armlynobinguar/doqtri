-- Retries of a new smart wallet's first Friendbot top-up (DOQ-6, WP-4.1).
--
-- Where wallets pay their own fees (testnet, USER_PAYS_FEES), /api/chain/relay
-- tops a new passkey wallet up with free test XLM while it deploys
-- (doqtri/frontend/lib/stellar/friendbot-topup.ts). Friendbot is often busy,
-- and a refusal was only logged: the wallet stayed empty and its first paid
-- write failed with 402 until the user found "Top up" themselves.
--
-- * wallet_topups holds those failed first top-ups. The relay queues one when
--   the first try fails and the deploy landed; GET /api/chain/jobs, the run
--   pg_cron makes every minute (20261025090000_chain_jobs_scheduler.sql),
--   retries it with the chain jobs' backoff until it lands or reaches the
--   retry cap, which the server owns (lib/stellar/wallet-topups.ts). Done and
--   failed rows are kept as the record; nothing claims them again.
--
-- * Not workspace_chain_jobs: that queue is per workspace, is visible to
--   workspace admins, and only runs with REGISTRY_EDITORS on. A top-up belongs
--   to a wallet and must run without them.
--
-- * Testnet only: Friendbot does not exist on mainnet, so `network` can only
--   be 'testnet', and a mainnet server neither queues nor claims (IS_MAINNET
--   in the server is the first guard; this check is the second).
--
-- * One open retry per wallet (the partial unique index): the relay inserts
--   and treats a conflict as already queued.
--
-- * claim_wallet_topups() leases due rows for two minutes and stamps a fresh
--   claim_token, as claim_workspace_chain_jobs() does
--   (20261025130000_chain_jobs_claim_token.sql), so the per-minute run and
--   the daily Vercel backstop never try the same wallet at once. The server
--   finishes a row by id and claim token, releasing the token.
--
-- * RLS on with no policies, and every privilege revoked from anon and
--   authenticated: only the service role reads or writes it. Nothing in the
--   app shows it to users.

create table public.wallet_topups (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  network         text not null default 'testnet' check (network = 'testnet'),
  address         text not null check (address ~ '^C[A-Z2-7]{55}$'),
  status          text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  attempts        integer not null default 0,
  last_error      text check (char_length(last_error) <= 500),
  tx_hash         text check (tx_hash ~ '^[0-9a-f]{64}$'),
  next_attempt_at timestamptz not null default now() + interval '1 minute',
  claim_token     uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  done_at         timestamptz
);

comment on table public.wallet_topups is
  'Failed first Friendbot top-ups of new testnet smart wallets, retried by GET /api/chain/jobs until done or the retry cap (DOQ-6). Service role only.';
comment on column public.wallet_topups.attempts is
  'Retries claimed so far; the failed first try in the relay is not counted.';
comment on column public.wallet_topups.claim_token is
  'Set by claim_wallet_topups(); the server finishes a row only while it still holds this token, and clears it as it does.';

create unique index wallet_topups_open_idx
  on public.wallet_topups (address) where status = 'pending';
create index wallet_topups_due_idx
  on public.wallet_topups (next_attempt_at) where status = 'pending';

alter table public.wallet_topups enable row level security;

create function public.wallet_topups_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.status = 'done' and old.status is distinct from 'done' then
    new.done_at := now();
  end if;
  return new;
end;
$$;

create trigger wallet_topups_before_update
  before update on public.wallet_topups
  for each row execute function public.wallet_topups_before_update();

-- Leases up to p_limit due retries, oldest first. Service role only.
create function public.claim_wallet_topups(p_limit integer default 5)
returns setof public.wallet_topups
language sql
security definer
set search_path = ''
as $$
  update public.wallet_topups t
     set attempts = t.attempts + 1,
         next_attempt_at = now() + interval '2 minutes',
         claim_token = gen_random_uuid()
   where t.id in (
     select c.id from public.wallet_topups c
      where c.status = 'pending'
        and c.next_attempt_at <= now()
      order by c.created_at
      limit greatest(1, least(coalesce(p_limit, 5), 50))
        for update skip locked
   )
  returning t.*;
$$;

comment on function public.claim_wallet_topups(integer) is
  'SECURITY DEFINER, service_role only. Leases due wallet top-up retries for two minutes, counts the attempt and stamps a fresh claim_token.';

revoke execute on function public.wallet_topups_before_update() from public, anon, authenticated;
revoke execute on function public.claim_wallet_topups(integer) from public, anon, authenticated;
grant execute on function public.claim_wallet_topups(integer) to service_role;

revoke all on public.wallet_topups from public, anon, authenticated;
grant select, insert, update, delete on public.wallet_topups to service_role;
