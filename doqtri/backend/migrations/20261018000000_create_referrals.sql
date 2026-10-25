-- Referral links: every user has one link, /r/<code>, unique to them.
--
-- A code reaches a visitor three ways: the link itself, a QR code of the link
-- (/r/<code>?via=qr), or typed into the sign-up form (/api/referrals/code).
-- Each stores the code in a signed, httpOnly cookie. After the visitor signs
-- up, by email, wallet or passkey, the vault calls /api/referrals/claim once,
-- which records who referred them, and how, through claim_referral(). A
-- referral only counts for an account created after the code was seen, so
-- existing users can't attach themselves to a code, and nobody can refer
-- themselves.
--
-- Both tables are written through the service role only (the /api/referrals
-- routes, after verifying the session). Owners can read their own code; the
-- referrals themselves are never exposed to the browser, only counts.

create table public.referral_codes (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  -- 8 characters, lowercase letters and digits without 0, 1, i, l and o so a
  -- link read aloud or retyped still works.
  code       text not null unique check (code ~ '^[a-hjkmnp-z2-9]{8}$'),
  created_at timestamptz not null default now()
);

alter table public.referral_codes enable row level security;

create policy "own referral code - select" on public.referral_codes
  for select using (auth.uid() = user_id);

create table public.referrals (
  -- One referrer per account: the primary key makes a second claim a no-op.
  referred_user_id uuid primary key references auth.users(id) on delete cascade,
  referrer_user_id uuid not null references auth.users(id) on delete cascade,
  code             text not null,
  -- How the code reached them: the link, a scanned QR code, or typed in.
  source           text not null default 'link' check (source in ('link', 'qr', 'code')),
  created_at       timestamptz not null default now(),
  check (referred_user_id <> referrer_user_id)
);

-- RLS on with no policies: service role only.
alter table public.referrals enable row level security;

create index referrals_referrer_idx on public.referrals (referrer_user_id, created_at desc);

-- The user's referral code, created on first use, plus how many accounts
-- signed up through it, in total and by how the code reached them.
create function public.referral_code_for(p_user_id uuid)
returns table (code text, referred integer, via_link integer, via_qr integer, via_code integer)
language plpgsql
set search_path = ''
as $$
declare
  v_alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  v_code     text;
begin
  select rc.code into v_code from public.referral_codes rc where rc.user_id = p_user_id;

  while v_code is null loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::integer, 1);
    end loop;
    begin
      insert into public.referral_codes (user_id, code) values (p_user_id, v_code)
      on conflict (user_id) do nothing;
      -- A concurrent call may have created the user's code first: use theirs.
      select rc.code into v_code from public.referral_codes rc where rc.user_id = p_user_id;
    exception when unique_violation then
      -- Another user already has this code; draw again.
      v_code := null;
    end;
  end loop;

  return query
    select v_code,
           count(*)::integer,
           (count(*) filter (where r.source = 'link'))::integer,
           (count(*) filter (where r.source = 'qr'))::integer,
           (count(*) filter (where r.source = 'code'))::integer
    from public.referrals r
    where r.referrer_user_id = p_user_id;
end;
$$;

-- Records that p_user_id signed up through p_code, which reached them via
-- p_source (link, qr or code; link when omitted, as by callers that predate
-- it). Returns false, and records nothing, when the code is unknown, is the
-- user's own, the account existed before the code was seen (p_clicked_at), or
-- the user already has a referrer.
--
-- Security definer because it reads auth.users.created_at, which the service
-- role can't select; execute is still granted to the service role only.
create function public.claim_referral(p_user_id uuid, p_code text, p_clicked_at timestamptz, p_source text default 'link')
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_referrer   uuid;
  v_created_at timestamptz;
  v_rows       integer;
begin
  select rc.user_id into v_referrer from public.referral_codes rc where rc.code = lower(p_code);
  if v_referrer is null or v_referrer = p_user_id then
    return false;
  end if;

  select u.created_at into v_created_at from auth.users u where u.id = p_user_id;
  -- A minute of slack for clock differences between the app and the database.
  if v_created_at is null or v_created_at < p_clicked_at - interval '1 minute' then
    return false;
  end if;

  insert into public.referrals (referred_user_id, referrer_user_id, code, source)
  values (p_user_id, v_referrer, lower(p_code), p_source)
  on conflict (referred_user_id) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke execute on function public.referral_code_for(uuid) from public, anon, authenticated;
grant execute on function public.referral_code_for(uuid) to service_role;
revoke execute on function public.claim_referral(uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.claim_referral(uuid, text, timestamptz, text) to service_role;
