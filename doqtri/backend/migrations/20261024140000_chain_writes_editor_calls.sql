-- Registry v3 (WP-1.3) lets any writer of a workspace document write it
-- through calls that name their signer: anchor_as, update_document_as and
-- set_node_status_as. A new team document is then put in its workspace with
-- assign_document, and taken out with unassign_document (WP-1.4). The relay
-- indexes every passkey-wallet document write in chain_writes so its history
-- can be found, and the fn check only allowed the four owner-only calls, so
-- these writes would go unindexed and the document's history would show as
-- incomplete.
--
-- `owner` keeps its meaning of "the wallet that signed the write", which for
-- the *_as calls is the signer, not the document's owner (D-28: a workspace
-- document is owned on-chain by the workspace owner). Membership calls
-- (add_editor and the like) belong to no document and are not indexed here.
--
-- No new table, so no new RLS: chain_writes keeps its public select and
-- service-role-only writes.

alter table public.chain_writes drop constraint chain_writes_fn_check;
alter table public.chain_writes
  add constraint chain_writes_fn_check
  check (fn in (
    'register_document', 'update_document', 'set_node_status', 'anchor',
    'anchor_as', 'update_document_as', 'set_node_status_as',
    'assign_document', 'unassign_document'
  ));
