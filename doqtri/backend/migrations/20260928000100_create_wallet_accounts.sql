-- Stellar public key -> Supabase user.
--
-- /api/auth/wallet used to recover an existing wallet user by scanning
-- auth.admin.listUsers(), which silently misses anyone past the first page and
-- races when two tabs connect at once. This table makes the lookup a primary-key
-- read, so the wallet -> session exchange is idempotent.
--
-- Service role only: RLS is on with no policies, so the browser cannot read or
-- enumerate the mapping.

create table public.wallet_accounts (
  address    text primary key check (address ~ '^G[A-Z2-7]{55}$'),
  user_id    uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.wallet_accounts enable row level security;
