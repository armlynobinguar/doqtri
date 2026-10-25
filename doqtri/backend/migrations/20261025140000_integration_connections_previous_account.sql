-- Connected apps: say which qdit account a reconnect replaced (WP-2.11, D-66).
--
-- A user may reconnect doqtri to a different qdit account (D-66). When that
-- happens the profile says "Now connected as X (was Y)". The callback route
-- sends only a fixed outcome code back to the profile (never a name from
-- qdit in the URL), so the account that was replaced is kept here:
--
--   previous_subject        the qdit user id the connection belonged to
--                           before the last connect, when that connect
--                           landed on another qdit account; null when it
--                           was the same account, or the first connect
--   previous_account_label  that account's username or display name, as
--                           account_label had it (at most 200 characters)
--
-- Both are written by the service role in the same update as the new
-- tokens (lib/integrations/connection-store.ts saveConnected) and read back
-- through my_integration_connections(), which now returns them. The table
-- keeps RLS on with no policies and no client privileges (20261025100000);
-- nothing here changes who can reach a row.

alter table public.integration_connections
  add column previous_subject text
    check (previous_subject is null or length(previous_subject) between 1 and 255),
  add column previous_account_label text
    check (previous_account_label is null or length(previous_account_label) <= 200);

comment on column public.integration_connections.previous_subject is
  'The qdit user id the last connect replaced, when it landed on another qdit account (D-66); else null.';
comment on column public.integration_connections.previous_account_label is
  'That replaced account''s label, for "Now connected as X (was Y)" (D-66).';

alter table public.integration_connections enable row level security;

-- The return type changes, so the function is dropped and made again, with
-- the same body, security and grants plus the two columns.
drop function public.my_integration_connections();

create function public.my_integration_connections()
returns table (
  provider               text,
  subject                text,
  account_label          text,
  scopes                 text[],
  status                 text,
  expires_at             timestamptz,
  connected_at           timestamptz,
  updated_at             timestamptz,
  previous_subject       text,
  previous_account_label text
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.provider, c.subject, c.account_label, c.scopes, c.status,
         c.expires_at, c.connected_at, c.updated_at,
         c.previous_subject, c.previous_account_label
    from public.integration_connections c
   where c.user_id = (select auth.uid())
   order by c.provider
$$;

comment on function public.my_integration_connections() is
  'The caller''s integration connections, token columns left out (WP-2.3; previous account, WP-2.11).';

revoke all on function public.my_integration_connections() from public, anon;
grant execute on function public.my_integration_connections() to authenticated, service_role;
