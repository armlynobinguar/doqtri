-- Pending paid writes (WP-4.1, DOQ-5).
--
-- The relay (doqtri/frontend/app/api/chain/relay/route.ts) waits about 20 s
-- for a paid write to land. One the network accepted but hasn't confirmed by
-- then used to answer 502 and leave no chain_writes row, although the
-- transaction could still land: the write was then on-chain but missing from
-- the note's history. Now the relay answers 202 and records the row as
-- pending, and the chain-jobs run (lib/stellar/pending-writes.ts, called from
-- /api/chain/jobs every minute) settles it: confirmed once the ledger has it,
-- failed once it failed on-chain or its 60 s time bound has certainly passed
-- without it landing.
--
--   status   pending | confirmed | failed. Every row written before this
--            migration was written after its write confirmed, so the default
--            backfills them as confirmed, and a writer that doesn't name a
--            status (the sponsored Channels path) still means confirmed.
--
-- Everything else that touches chain_writes was checked and keeps working:
--
--   "chain writes - public select"   unchanged. The status is as public as
--                                    the ledger it mirrors, and the history
--                                    page needs it signed out.
--   writes                           still service role only (no insert,
--                                    update or delete policy); only the relay
--                                    and the chain-jobs run write.
--   chain_writes_fn_check            unchanged.
--   handle_deleted_user_workspaces() counts a note with any row as anchored.
--                                    A pending row may still land, so that
--                                    is right for it; a note whose only row
--                                    failed is counted too, which keeps the
--                                    account rather than losing anything
--                                    (follow-up: count only non-failed rows).
--   documents ← chain_writes         `on delete restrict` stays, so a
--                                    confirmed or pending write still keeps
--                                    its note. A failed write anchored
--                                    nothing, so deleting the note first
--                                    removes its failed rows (the trigger
--                                    below); without that, a note whose first
--                                    write failed could never be deleted.

alter table public.chain_writes
  add column status text not null default 'confirmed'
    constraint chain_writes_status_check check (status in ('pending', 'confirmed', 'failed'));

-- The chain-jobs run reads the pending rows, oldest first, every minute.
create index chain_writes_pending_idx
  on public.chain_writes (network, created_at)
  where status = 'pending';

-- A failed write is on the ledger only as a failure: it changed no note, so
-- it holds none back.
create function public.drop_failed_chain_writes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.chain_writes c
   where c.document_id = old.id and c.status = 'failed';
  return old;
end;
$$;

revoke execute on function public.drop_failed_chain_writes() from public, anon, authenticated;

create trigger documents_drop_failed_chain_writes
  before delete on public.documents
  for each row execute function public.drop_failed_chain_writes();
