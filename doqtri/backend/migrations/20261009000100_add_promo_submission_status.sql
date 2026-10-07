-- Review state for promo entries, set from the /admin/promo screen.
--
-- pending → shortlisted → winner, or rejected. Resubmitting an entry puts it
-- back to pending, since the screenshots it was judged on are gone.
-- Only the service role writes it; the owner-select policy is unchanged.

alter table public.promo_submissions
  add column status text not null default 'pending'
    check (status in ('pending', 'shortlisted', 'winner', 'rejected')),
  add column reviewed_at timestamptz;
