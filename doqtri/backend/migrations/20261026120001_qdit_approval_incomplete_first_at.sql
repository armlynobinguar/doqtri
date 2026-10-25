-- Incomplete approval scans give up too (WP-1.12, D-92).
--
-- 20261026110000_qdit_approval_incomplete_scans.sql throttles a lookup that
-- ran out of its page budget to once an hour, without starting the 8-day
-- give-up clock of qdit_milestone_approval_misses (the event may still be in
-- RPC's window). But nothing ever stopped it: a milestone whose scans always
-- run out was rescanned hourly for good, long after its event had left the
-- window. D-92: such a key stops being scanned GIVE_UP_AFTER_MS after its
-- first incomplete scan, on a clock of its own.
--
--   first_incomplete_at   when a lookup of the approval first ran out of
--                         budget. Set once, on insert, and never moved: the
--                         service role may still update last_attempt_at
--                         only. The approval existed then, so its event has
--                         left RPC's window 8 days later. Kept apart from
--                         the misses' first_missed_at: an incomplete scan
--                         still never starts the miss clock.
--
-- Rows recorded before this migration take their last attempt as their
-- first: the latest it can have been, so they are scanned for longer, never
-- for less.

alter table public.qdit_milestone_approval_incomplete_scans
  add column first_incomplete_at timestamptz;

update public.qdit_milestone_approval_incomplete_scans
   set first_incomplete_at = last_attempt_at;

alter table public.qdit_milestone_approval_incomplete_scans
  alter column first_incomplete_at set default now(),
  alter column first_incomplete_at set not null;

comment on column public.qdit_milestone_approval_incomplete_scans.first_incomplete_at is
  'When a lookup of this approval first ran out of its RPC page budget (D-92). Set once, never moved; the app stops scanning GIVE_UP_AFTER_MS after it. Separate from the misses'' first_missed_at.';
comment on table public.qdit_milestone_approval_incomplete_scans is
  'When a lookup of a qdit approval transaction first and last ran out of its RPC page budget before covering the event window (WP-2.13, D-92). Throttles rescans and stops them after the give-up period; never starts the give-up clock in qdit_milestone_approval_misses. Service role only; only last_attempt_at may change.';
