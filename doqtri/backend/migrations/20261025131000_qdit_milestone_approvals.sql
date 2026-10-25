-- qdit approval transactions, for the public receipts (WP-3.1).
--
-- docs/integration/CONTRACT.md is the reference; section numbers point into
-- it. The public audit page (/d/[docId]) shows, for each heading whose
-- on-chain record was signed from a qdit milestone (`tool = "qdit"`,
-- section 10), a receipt: what milestone_proof says about the milestone now,
-- doqtri's own signing transaction, and the transaction that approved the
-- milestone. The first two come from the chain and doqtri's history. The
-- third is not in the milestone's record (MilestoneRecord holds no
-- transaction hash), only in the `("qdit", "approve", project_id)` event the
-- approval published, and Stellar RPC keeps events for about a week. So
-- when doqtri reads a milestone as Approved (the webhook, or the ship
-- panel's re-check, WP-2.8) it looks the event up in RPC's window and keeps
-- the transaction here, so the receipt can link to it after the event has
-- left the window.
--
--   qdit_milestone_approvals  one row per approved (milestone, version) on
--                             one contract: an immutable fact, found on the
--                             chain itself, never taken from qdit's API.
--                             Rows outlive the link (unlinking does not undo
--                             an approval, and the node record that cites it
--                             stays on chain). Service role only: the
--                             webhook and re-check write it, the audit page
--                             reads it server-side. Every column is public
--                             chain data, but nothing here needs a browser.
--   qdit_milestone_approval_misses
--                             when a lookup of an approval first came back
--                             empty. The approval already existed then, so
--                             once that is older than RPC's window (about a
--                             week; the app waits 8 days) the event is gone
--                             and doqtri stops scanning for it. A lookup that
--                             failed (RPC down, timeout) records no miss, so
--                             a later sighting tries again. Service role
--                             only, insert-only like the approvals.

create table public.qdit_milestone_approvals (
  network      text not null check (network in ('testnet', 'mainnet')),
  contract_id  text not null check (contract_id ~ '^C[A-Z2-7]{55}$'),
  project_id   uuid not null,
  milestone_id uuid not null,
  -- MilestoneRecord.version the approval kept (a u32, so bigint).
  version      bigint not null check (version between 1 and 4294967295),
  tx_hash      text not null check (tx_hash ~ '^[0-9a-f]{64}$'),
  -- The ledger the approval closed in.
  ledger       bigint not null check (ledger >= 1),
  recorded_at  timestamptz not null default now(),
  primary key (network, contract_id, project_id, milestone_id, version)
);

comment on table public.qdit_milestone_approvals is
  'Transactions that approved a qdit milestone version on milestone_proof, from the chain''s own events (WP-3.1). Service role only; insert-only.';

-- The audit page asks by milestone, for the handful on one note.
create index qdit_milestone_approvals_milestone_idx on public.qdit_milestone_approvals (milestone_id);

alter table public.qdit_milestone_approvals enable row level security;

-- No policy, and no privilege either. Insert only, even for the service
-- role: an approval found once is a fact, so a later lookup can add a
-- missing row (insert ... on conflict do nothing) but never change one.
revoke all on table public.qdit_milestone_approvals from public, anon, authenticated, service_role;
grant select, insert on table public.qdit_milestone_approvals to service_role;

-- ---------------------------------------------------------------------------
-- qdit_milestone_approval_misses
-- ---------------------------------------------------------------------------

create table public.qdit_milestone_approval_misses (
  network         text not null check (network in ('testnet', 'mainnet')),
  contract_id     text not null check (contract_id ~ '^C[A-Z2-7]{55}$'),
  project_id      uuid not null,
  milestone_id    uuid not null,
  version         bigint not null check (version between 1 and 4294967295),
  -- The first empty lookup; later ones change nothing (on conflict do nothing).
  first_missed_at timestamptz not null default now(),
  primary key (network, contract_id, project_id, milestone_id, version)
);

comment on table public.qdit_milestone_approval_misses is
  'When a lookup of a qdit approval transaction in Stellar RPC''s event window first found nothing (WP-3.1). Service role only; insert-only.';

alter table public.qdit_milestone_approval_misses enable row level security;

revoke all on table public.qdit_milestone_approval_misses from public, anon, authenticated, service_role;
grant select, insert on table public.qdit_milestone_approval_misses to service_role;
