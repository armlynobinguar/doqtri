-- A deleted creator's templates: free ones stay, paid ones are hidden,
-- drafts go (WP-1.12, D-89).
--
-- 20261026100000_account_deletion_anonymises.sql kept every template of a
-- deleted account listed as it was, with creator_id null and creator_wallet
-- as the on-chain identity (D-63). D-89 narrows that for two kinds:
--
--   paid templates      hidden from the gallery (hidden = true, the same
--                       hide an admin applies after a copy report). A new
--                       sale would pay a wallet whose account is gone: for a
--                       passkey wallet nobody can sign for it any more
--                       (wallet_passkeys went with the account), and nobody
--                       is left to answer for what is being sold. The
--                       contract listing stays (the chain is not censored,
--                       only Doqtri's gallery), as for an admin hide.
--   'pending' templates deleted. A pending row is a draft that was never
--                       confirmed on chain, and with creator_id null nobody
--                       could ever confirm, sync or remove it
--                       (publish/confirm and market/sync match on
--                       creator_id): it would stay for good as an orphan
--                       copy of unpublished content. A pending template
--                       cannot be bought, and publish never takes one as a
--                       parent, so none should be referenced; one that is
--                       anyway (a purchase or a child) is kept rather than
--                       letting a restrict refuse the deletion.
--
-- Unchanged from 20261026100000: free templates stay listed, credited to
-- their wallet ("Former user" in the gallery); every purchase stays valid.
-- A buyer copies a hidden paid template again for free as before
-- (app/api/market/claim/route.ts: a purchase on chain skips the listed and
-- hidden checks), so buyer access is unchanged. An admin may still unhide
-- one (PATCH /api/admin/market/templates/[id]).
--
-- Everything else in handle_deleted_user_workspaces() is as in
-- 20261026100000; the template step runs before the cascades, while
-- creator_id still names the account.

comment on column public.market_templates.hidden is
  'Hidden from the gallery: by an admin after a copy report, or when the creator''s account is deleted and the template is paid (D-89). The contract listing stays.';


-- ---------------------------------------------------------------------------
-- Deleting an account (D-31, D-50, D-63, D-89)
-- ---------------------------------------------------------------------------

create or replace function public.handle_deleted_user_workspaces()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws       record;
  v_admin    uuid;
  v_personal uuid;
begin
  perform public.enqueue_chain_revocation(m.workspace_id, old.id)
     from public.workspace_members m
    where m.user_id = old.id and m.role in ('editor', 'admin');

  delete from public.workspace_invites i
   where i.invitee = any (public.invite_identifiers_of(old.id))
      or i.invited_by = old.id;

  update public.ingests i
     set user_id = null
   where i.user_id = old.id and i.document_id is not null;

  -- D-89: drafts never confirmed on chain go; paid listings leave the
  -- gallery; free ones stay as they are.
  delete from public.market_templates t
   where t.creator_id = old.id and t.status = 'pending'
     and not exists (select 1 from public.market_purchases p where p.template_id = t.id)
     and not exists (select 1 from public.market_templates c where c.parent_id = t.id);
  update public.market_templates t
     set hidden = true
   where t.creator_id = old.id and t.price > 0 and t.status <> 'pending' and not t.hidden;

  select w.id into v_personal
    from public.workspaces w
   where w.is_personal and w.created_by = old.id
     for update;
  if v_personal is not null then
    if exists (select 1 from public.documents d where d.workspace_id = v_personal)
       or exists (
         select 1 from public.workspace_members m
          where m.workspace_id = v_personal and m.user_id <> old.id
       )
    then
      update public.workspaces w
         set name = 'Former user'
       where w.id = v_personal;
    else
      delete from public.workspaces w where w.id = v_personal;
    end if;
  end if;

  for v_ws in
    select w.id, w.name
      from public.workspaces w
      join public.workspace_members m on m.workspace_id = w.id
     where m.user_id = old.id and m.role = 'owner' and not w.is_personal
     order by w.id
       for update of w
  loop
    continue when exists (
      select 1 from public.workspace_members m
       where m.workspace_id = v_ws.id and m.role = 'owner' and m.user_id <> old.id
    );

    perform 1
       from public.workspace_members m
      where m.workspace_id = v_ws.id and m.role = 'admin'
        for update;
    select m.user_id into v_admin
      from public.workspace_members m
     where m.workspace_id = v_ws.id and m.role = 'admin'
     order by m.joined_at, m.user_id
     limit 1;
    if v_admin is null then
      raise exception 'this account is the last owner of workspace "%" (%), which has no admin to take it over',
        v_ws.name, v_ws.id
        using errcode = 'restrict_violation',
              hint = 'Make another member of that workspace an owner or an admin, then delete the account.';
    end if;

    update public.workspace_members m
       set role = 'owner'
     where m.workspace_id = v_ws.id and m.user_id = v_admin;

    update public.workspace_chain_jobs j
       set user_id = v_admin, status = 'pending', attempts = 0,
           last_error = null, next_attempt_at = now()
     where j.workspace_id = v_ws.id and j.kind = 'reassign_owner'
       and j.status in ('pending', 'needs_product_owner');
    if not found then
      insert into public.workspace_chain_jobs (workspace_id, kind, user_id)
      values (v_ws.id, 'reassign_owner', v_admin);
    end if;
  end loop;

  return old;
end;
$$;

revoke execute on function public.handle_deleted_user_workspaces() from public, anon, authenticated;
