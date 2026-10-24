-- AI rating for promo entries, so a large event (the hackathon) can be ranked
-- before anyone opens the review screen.
--
-- /api/promo/submissions rates each entry right after it is saved; admins can
-- re-rate from /admin/promo. The rating only orders the queue: status is still
-- set by a person. Resubmitting clears all four columns, since the screenshots
-- that were rated are gone.
--
-- ai_score    weighted 0-100 total, computed in code from the criteria scores
-- ai_rating   { criteria: { <key>: { score 0-10, note } }, summary, flags, model }
-- ai_rated_at when ai_score/ai_rating were written
-- ai_rating_error  last failure, cleared on success; null when never attempted
--
-- Only the service role writes these; the owner-select policy is unchanged, so
-- an entrant could read their own score over the API. The UI does not show it.

alter table public.promo_submissions
  add column ai_score smallint check (ai_score between 0 and 100),
  add column ai_rating jsonb,
  add column ai_rated_at timestamptz,
  add column ai_rating_error text check (char_length(ai_rating_error) <= 500);

create index promo_submissions_promo_score_idx
  on public.promo_submissions (promo, ai_score desc nulls last);
