-- Referral testimonials (WP-4.6, DOQ-28, D-113): a referrer's optional feedback,
-- their opt-in to show it publicly, and an admin's approval.
--
-- One row per user, only while they have feedback: clearing the text deletes the
-- row. Kept apart from referral_payout_profiles on purpose, so feedback is never
-- read in the same query as bank details. The name shown publicly is the payout
-- questionnaire's name, which only the public function below joins in, and only
-- that column.
--
-- What it takes to be public, all at once: consent is on, an admin approved the
-- text as it stands, and the user still has a questionnaire name. The database
-- keeps approval honest, whoever writes:
--   - a new row is never approved or rejected;
--   - editing the text, or withdrawing consent, clears approval and rejection,
--     so an edit always goes back to review (AC 5);
--   - a questionnaire name that is new, changed or removed clears approval
--     too: what an admin approved was this name with this text. Approval
--     needs a name, so a nameless testimonial is never approved and can't go
--     public under a name saved after the fact;
--   - approval and rejection need consent, and never both at once.
-- consented_at and updated_at are the database's, whatever the writer sends.
-- updated_at is the row's version: an admin's decision names the version they
-- read, so text edited since can't be approved unseen.
--
-- The feedback has the payout name's character rules (referral_payout_text_ok()
-- and referral_payout_text_visible(), from 20261107120000), at most 500
-- characters. The app's validator (lib/referral-testimonial.ts) is what users
-- meet; these checks are the backstop.
--
-- RLS on. The owner can read their own row's text, consent and decision, but
-- not who decided or when they consented (column grants); no policy allows any
-- write, so writes go through the service role, from the routes. anon has no
-- privileges.
-- Goes with the account (on delete cascade). The approving admin's id goes if
-- their account does (on delete set null), and the approval stays.

create table public.referral_testimonials (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  feedback     text not null check (
    char_length(feedback) between 1 and 500
    and public.referral_payout_text_ok(feedback) and public.referral_payout_text_visible(feedback)),
  consent      boolean not null default false,
  consented_at timestamptz,
  approved_at  timestamptz,
  approved_by  uuid references auth.users(id) on delete set null,
  rejected_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint referral_testimonials_consented_at check (consent = (consented_at is not null)),
  constraint referral_testimonials_review_needs_consent check (consent or (approved_at is null and rejected_at is null)),
  constraint referral_testimonials_one_decision check (approved_at is null or rejected_at is null),
  constraint referral_testimonials_approved_by check (approved_by is null or approved_at is not null)
);

comment on table public.referral_testimonials is
  'A referrer''s feedback, their opt-in to show it, and an admin''s decision (DOQ-28, D-113). Public only with consent and approval, through referral_testimonials_public().';
comment on column public.referral_testimonials.updated_at is
  'The row''s version: set by the database on every write. An admin''s decision names the version it was made on.';

-- consented_at, approval and the version, whatever the writer sent.
create function public.referral_testimonials_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.approved_at := null;
    new.approved_by := null;
    new.rejected_at := null;
    new.consented_at := case when new.consent then clock_timestamp() end;
    new.created_at := clock_timestamp();
  else
    new.created_at := old.created_at;
    if new.feedback is distinct from old.feedback or (old.consent and not new.consent) then
      new.approved_at := null;
      new.approved_by := null;
      new.rejected_at := null;
    end if;
    new.consented_at := case
      when not new.consent then null
      when old.consent then old.consented_at
      else clock_timestamp()
    end;
  end if;
  -- clock_timestamp(), not now(): two writes in one transaction are two versions.
  -- And always later than the last one, so a coarse clock can't repeat a version.
  new.updated_at := case
    when tg_op = 'UPDATE' then greatest(clock_timestamp(), old.updated_at + interval '1 microsecond')
    else clock_timestamp()
  end;
  return new;
end;
$$;

create trigger referral_testimonials_before_write
  before insert or update on public.referral_testimonials
  for each row execute function public.referral_testimonials_before_write();

-- A questionnaire name that is new, changed or removed sends an approved
-- testimonial back to review. It also moves the testimonial's version, approved
-- or not, so an admin who read the list under the old name (or none) gets
-- "changed" rather than approving a name they never saw.
create function public.referral_payout_profiles_name_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.name is not distinct from new.name then
    return null;
  end if;
  update public.referral_testimonials
     set approved_at = null, approved_by = null
   where user_id = case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  return null;
end;
$$;

create trigger referral_payout_profiles_name_changed
  after insert or delete or update of name on public.referral_payout_profiles
  for each row execute function public.referral_payout_profiles_name_changed();

alter table public.referral_testimonials enable row level security;

create policy "Owners can read their testimonial"
  on public.referral_testimonials for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.referral_testimonials from public, anon, authenticated;
-- What the questionnaire shows its owner: the text, the consent and where it
-- stands. Not approved_by, consented_at or the version.
grant select (user_id, feedback, consent, approved_at, rejected_at) on public.referral_testimonials to authenticated;
grant select, insert, update, delete on public.referral_testimonials to service_role;

-- ---------------------------------------------------------------------------
-- What the landing page shows
-- ---------------------------------------------------------------------------

-- The approved, consented testimonials: the questionnaire's name and the text,
-- and nothing else (AC 3). No id, date, wallet, email or payout detail. Newest
-- approval first, ties by user, at most 12. Without a questionnaire name there
-- is nothing to show it under, so it isn't shown.
create function public.referral_testimonials_public()
returns table (name text, feedback text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.name, t.feedback
    from public.referral_testimonials t
    join public.referral_payout_profiles p on p.user_id = t.user_id
   where t.consent and t.approved_at is not null
   order by t.approved_at desc, t.user_id
   limit 12;
$$;

comment on function public.referral_testimonials_public() is
  'Name and feedback of consented, approved testimonials, at most 12 (DOQ-28, D-113). Service role only: the landing page reads it on the server.';

-- ---------------------------------------------------------------------------
-- Admin review
-- ---------------------------------------------------------------------------

-- Every testimonial, for /admin/referrals/payouts: who, the name and text, and
-- where it stands. Private feedback (no consent) is listed too, for admins to
-- read, never to approve. Waiting for review first, then the rest with
-- consent, then private; newest edit first within each.
create function public.referral_testimonials_for_review()
returns table (
  user_id     uuid,
  name        text,
  feedback    text,
  consent     boolean,
  approved_at timestamptz,
  rejected_at timestamptz,
  updated_at  timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.user_id, p.name, t.feedback, t.consent, t.approved_at, t.rejected_at, t.updated_at
    from public.referral_testimonials t
    left join public.referral_payout_profiles p on p.user_id = t.user_id
   order by (t.consent and t.approved_at is null and t.rejected_at is null) desc, t.consent desc,
            t.updated_at desc, t.user_id;
$$;

-- Approves or rejects the testimonial as it was at p_version. Returns what
-- happened: approved, rejected, changed (edited or deleted since p_version),
-- private (no consent, so nothing to decide), no_name (approval asked for, and
-- no questionnaire name to show it under: an admin must see the name they
-- approve) or admin_gone. Rejecting needs no name. p_admin comes from the
-- route's verified admin session.
create function public.referral_testimonial_review(
  p_user_id uuid,
  p_version timestamptz,
  p_approve boolean,
  p_admin   uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.referral_testimonials%rowtype;
begin
  if p_user_id is null or p_version is null or p_approve is null or p_admin is null then
    raise exception 'referral_testimonial_review: an argument is missing' using errcode = '22023';
  end if;

  select * into v_row from public.referral_testimonials where user_id = p_user_id for update;
  if not found or v_row.updated_at <> p_version then
    return 'changed';
  end if;
  if not v_row.consent then
    return 'private';
  end if;
  if p_approve and not exists (select 1 from public.referral_payout_profiles p where p.user_id = p_user_id) then
    return 'no_name';
  end if;

  begin
    update public.referral_testimonials
       set approved_at = case when p_approve then clock_timestamp() end,
           approved_by = case when p_approve then p_admin end,
           rejected_at = case when p_approve then null else clock_timestamp() end
     where user_id = p_user_id;
  exception when foreign_key_violation then
    return 'admin_gone';
  end;
  return case when p_approve then 'approved' else 'rejected' end;
end;
$$;

comment on function public.referral_testimonial_review(uuid, timestamptz, boolean, uuid) is
  'An admin approves or rejects a testimonial as it was at p_version (DOQ-28). Service role only.';

-- ---------------------------------------------------------------------------
-- Service role only
-- ---------------------------------------------------------------------------

revoke execute on function
  public.referral_testimonials_before_write(),
  public.referral_payout_profiles_name_changed(),
  public.referral_testimonials_public(),
  public.referral_testimonials_for_review(),
  public.referral_testimonial_review(uuid, timestamptz, boolean, uuid)
  from public, anon, authenticated;
-- The triggers' own: nothing calls them.
revoke execute on function
  public.referral_testimonials_before_write(),
  public.referral_payout_profiles_name_changed()
  from service_role;
grant execute on function
  public.referral_testimonials_public(),
  public.referral_testimonials_for_review(),
  public.referral_testimonial_review(uuid, timestamptz, boolean, uuid)
  to service_role;
