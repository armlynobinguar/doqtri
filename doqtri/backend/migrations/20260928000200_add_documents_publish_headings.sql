-- Owner opt-in for showing heading labels on the public /d/[docId] audit page.
--
-- The ledger only holds positional node ids (`h0`, `h1`, ...). Headings live in
-- the private markdown, so revealing them is the owner's choice and is off by
-- default. Even when on, the audit page shows labels only while the current
-- markdown still hashes to the anchored content hash.

alter table public.documents
  add column publish_headings boolean not null default false;
