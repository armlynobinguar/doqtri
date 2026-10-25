-- An owner's removal ends when the handover lands (WP-1.10 review, WP-1.11).
--
-- signer_removals_for_document() (20261025130000_chain_jobs_claim_token.sql)
-- returns, with each removal of a signer from a note's workspace, when that
-- wallet's revocation was done (`revoked_at`), so the public audit page reads
-- a removed member's feed only until their wallet left the chain's editor
-- list (doqtri/frontend/lib/stellar/history.ts). It looked at 'revoke' jobs
-- only. Owners are never revoked, though: when the last owner of a team
-- workspace deletes their account, handle_deleted_user_member_removals()
-- logs a removal with role 'owner', and their role leaves the chain through
-- the reassign_owner job instead (D-31). That removal's revoked_at stayed
-- null for good, and every view of every note in the workspace read the old
-- owner's feed from the removal to now.
--
-- Such a removal now takes the time the workspace's last handover between
-- the removal and the restoration was done. The handover names the heir,
-- not the wallet, so it is matched by workspace only. A revocation of the
-- wallet, should one exist, still comes first.
create or replace function public.signer_removals_for_document(p_document_id uuid)
returns table (address text, removed_at timestamptz, restored_at timestamptz, revoked_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select a.address, r.removed_at, r.restored_at,
         coalesce(
           (select max(j.done_at)
              from public.workspace_chain_jobs j
             where j.workspace_id = r.workspace_id
               and j.kind = 'revoke'
               and j.address = a.address
               and j.status = 'done'
               and j.done_at >= r.removed_at
               and (r.restored_at is null or j.done_at <= r.restored_at)),
           case when r.role = 'owner' then
             (select max(j.done_at)
                from public.workspace_chain_jobs j
               where j.workspace_id = r.workspace_id
                 and j.kind = 'reassign_owner'
                 and j.status = 'done'
                 and j.done_at >= r.removed_at
                 and (r.restored_at is null or j.done_at <= r.restored_at))
           end
         )
    from public.documents d
    join public.workspace_member_removals r on r.workspace_id = d.workspace_id
    cross join lateral unnest(r.wallet_addresses) as a(address)
   where d.id = p_document_id
   order by r.removed_at, a.address;
$$;

revoke execute on function public.signer_removals_for_document(uuid) from public, anon, authenticated;
grant execute on function public.signer_removals_for_document(uuid) to service_role;
