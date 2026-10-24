-- Connected apps: a doqtri user's link to their qdit account (WP-2.3, D-02).
--
-- qdit is an OAuth 2.1 provider and doqtri a confidential client (D-02,
-- docs/integration/CONTRACT.md section 5). Each doqtri user connects their
-- own qdit account; doqtri then calls qdit's /api/v1 as that user, and qdit's
-- project roles apply (D-20). This table holds the result of that connect:
-- one row per (user, provider), today only provider 'qdit'.
--
--   subject        the qdit user id (`sub`, from GET /api/v1/me), so doqtri
--                  can tell which qdit account a connection belongs to
--   account_label  qdit's username or display name, for "Connected as ..."
--   scopes         what qdit granted, space-split from the token response
--   *_ciphertext   the access and refresh tokens, AES-256-GCM encrypted by
--                  the app with INTEGRATION_TOKEN_KEY before they get here
--                  (lib/integrations/token-crypto.ts). The database never
--                  sees a token in the clear
--   status         connected        tokens present and usable
--                  needs_reconnect  qdit refused the refresh token (the user
--                                   revoked doqtri in qdit, or the grant
--                                   expired): the tokens are gone and the
--                                   profile asks the user to reconnect
--                  revoked          the user disconnected in doqtri: the
--                                   tokens are gone; the row stays so the
--                                   profile can say which account it was
--   generation     +1 on every token write. Refreshes run on several server
--                  instances at once; each writes back only if the
--                  generation it read is still current, so two refreshes
--                  never overwrite each other's rotated refresh token
--
-- Tokens are never readable by a client role. The table has RLS on and no
-- policies, and anon and authenticated hold no privileges on it at all: only
-- the service role, in the integration routes, reads and writes it, always
-- for a user id taken from the verified session. The browser learns its own
-- connection's status through my_integration_connections(), which returns
-- every column except the tokens and the generation.
--
-- Deleting an account deletes its connections (on delete cascade). The
-- grant on qdit's side is the user's to revoke there (contract section 2).

create table public.integration_connections (
  user_id                  uuid not null references auth.users(id) on delete cascade,
  provider                 text not null check (provider in ('qdit')),
  subject                  text not null check (length(subject) between 1 and 255),
  account_label            text check (account_label is null or length(account_label) <= 200),
  scopes                   text[] not null default '{}',
  access_token_ciphertext  text,
  refresh_token_ciphertext text,
  -- When the access token expires. Null if qdit did not say.
  expires_at               timestamptz,
  status                   text not null default 'connected'
                             check (status in ('connected', 'needs_reconnect', 'revoked')),
  generation               bigint not null default 1 check (generation >= 1),
  -- The last time the user went through qdit's consent.
  connected_at             timestamptz not null default now(),
  refreshed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  primary key (user_id, provider),
  -- A connected row has an access token; any other row holds no token at all.
  constraint integration_connections_tokens_match_status check (
    case when status = 'connected'
      then access_token_ciphertext is not null
      else access_token_ciphertext is null and refresh_token_ciphertext is null
    end
  )
);

comment on table public.integration_connections is
  'A user''s OAuth connection to qdit (WP-2.3). Service role only; tokens are AES-256-GCM ciphertext. Status via my_integration_connections().';
comment on column public.integration_connections.subject is
  'The qdit user id (sub) the tokens belong to.';
comment on column public.integration_connections.generation is
  'Bumped on every token write; a refresh writes back only if the generation it read is still current.';

alter table public.integration_connections enable row level security;

-- No policies: RLS on with none denies every client role. The privileges are
-- revoked too, so a policy added later by mistake still exposes nothing.
revoke all on table public.integration_connections from public, anon, authenticated;
grant select, insert, update, delete on table public.integration_connections to service_role;

create function public.integration_connections_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger integration_connections_stamp
  before update on public.integration_connections
  for each row execute function public.integration_connections_stamp();

-- The signed-in user's own connections, without the tokens: what the
-- profile's Connected apps shows.
create function public.my_integration_connections()
returns table (
  provider      text,
  subject       text,
  account_label text,
  scopes        text[],
  status        text,
  expires_at    timestamptz,
  connected_at  timestamptz,
  updated_at    timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.provider, c.subject, c.account_label, c.scopes, c.status,
         c.expires_at, c.connected_at, c.updated_at
    from public.integration_connections c
   where c.user_id = (select auth.uid())
   order by c.provider
$$;

comment on function public.my_integration_connections() is
  'The caller''s integration connections, token columns left out (WP-2.3).';

revoke all on function public.my_integration_connections() from public, anon;
grant execute on function public.my_integration_connections() to authenticated, service_role;
revoke all on function public.integration_connections_stamp() from public, anon, authenticated;
