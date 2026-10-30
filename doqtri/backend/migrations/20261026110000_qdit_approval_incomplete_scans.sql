-- Throttle incomplete approval lookups (WP-2.13, wave-5 review).
--
-- 20261025131000_qdit_milestone_approvals.sql records an approval's
-- transaction when doqtri finds its event in Stellar RPC's window, and keeps
-- a miss (qdit_milestone_approval_misses) when a scan covered the whole
-- window and found nothing: the app then rescans at most hourly and gives up
-- 8 days after the first miss. A scan that ran out of its page budget before
-- covering the window is not a miss (the event may still be there), so it
-- records nothing there and must not start that 8-day clock. But with
-- nothing recorded it was not throttled either: for a milestone whose scans
-- keep running out of budget (an RPC that caps the ledger range per request
-- makes the scan bisect), every sighting ran a new scan, for good.
--
--   qdit_milestone_approval_incomplete_scans
--                    when a lookup of an approval last ran out of its budget.
--                    The app skips the key for an hour after it, as it does
--                    after a miss, and nothing here moves the misses table,
--                    so the give-up clock still starts only at a real miss.
--                    A separate table rather than a column on the misses
--                    table, whose first_missed_at is the give-up clock and
--                    is never null or moved. Service role only, like the
--                    other two tables: the webhook and the re-check write
--                    it, nothing reads it from a browser.
--
-- A lookup that failed outright (RPC down, timeout) still records nothing,
-- so a later sighting tries again.

create table public.qdit_milestone_approval_incomplete_scans (
  network         text not null check (network in ('testnet', 'mainnet')),
  contract_id     text not null check (contract_id ~ '^C[A-Z2-7]{55}$'),
  project_id      uuid not null,
  milestone_id    uuid not null,
  version         bigint not null check (version between 1 and 4294967295),
  -- The latest lookup that ran out of budget; the app waits an hour before the next.
  last_attempt_at timestamptz not null default now(),
  primary key (network, contract_id, project_id, milestone_id, version)
);

comment on table public.qdit_milestone_approval_incomplete_scans is
  'When a lookup of a qdit approval transaction last ran out of its RPC page budget before covering the event window (WP-2.13). Throttles rescans; never starts the give-up clock in qdit_milestone_approval_misses. Service role only; only last_attempt_at may change.';

alter table public.qdit_milestone_approval_incomplete_scans enable row level security;

revoke all on table public.qdit_milestone_approval_incomplete_scans from public, anon, authenticated, service_role;
grant select, insert on table public.qdit_milestone_approval_incomplete_scans to service_role;
grant update (last_attempt_at) on table public.qdit_milestone_approval_incomplete_scans to service_role;
