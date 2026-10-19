-- Registry v2 adds anchor(owner, doc_id, content_hash, nodes): the text and
-- any node statuses in one write. The relay indexes passkey-wallet writes in
-- chain_writes so their history can be found, and its fn check only allowed
-- the three original calls, so an anchor write would go unindexed and the
-- document's history would show as incomplete.

alter table public.chain_writes drop constraint chain_writes_fn_check;
alter table public.chain_writes
  add constraint chain_writes_fn_check
  check (fn in ('register_document', 'update_document', 'set_node_status', 'anchor'));
