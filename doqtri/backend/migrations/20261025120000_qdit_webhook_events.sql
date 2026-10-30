-- qdit milestone status sync (WP-2.8).
--
-- docs/integration/CONTRACT.md is the reference for every rule here; section
-- numbers below point into it. qdit tells doqtri that a linked milestone
-- moved with one signed webhook, `milestone.status_changed` (section 9), and
-- doqtri then reads the milestone's record on qdit's `milestone_proof`
-- contract itself, because the chain is the truth (D-04): the webhook and
-- qdit's `status` field are only signals. What it read decides what the ship
-- panel suggests for the linked heading (D-19), and an editor signs that
-- with their own wallet (D-14). Nothing here signs or writes to the chain.
--
--   qdit_webhook_events    every event doqtri acted on, by its id, so a
--                          delivery qdit retries (section 9: same id, same
--                          body) is answered and not acted on twice (R-09).
--                          Service role only.
--   qdit_milestone_states  per linked milestone, the last thing qdit said
--                          (`qdit_status`, a preview) and the last record
--                          read from the chain. Workspace viewers of a note
--                          linking the milestone read it (they see the
--                          suggestion, not the button, D-14); only the
--                          service role writes it, through
--                          record_qdit_milestone_state().
--   doc_project_links      gains the project's chain as qdit reported it
--                          (`chain` on the project, section 7), so the
--                          webhook, which has no user's qdit token to ask
--                          with, knows which contract to read.
--
-- Order (D-25). qdit delivers a milestone's events one at a time, but a dead
-- event releases the next, and a delivered one can still be processed late
-- here, so events can arrive out of order or repeat. Two guards keep the
-- newest state: qdit_status only moves to an event at least as new
-- (`occurred_at`) as the one it came from, and a chain read only replaces one
-- taken at an earlier or equal ledger. Since every event and every re-check
-- reads the chain again, a missed or late event costs nothing but a delay.

-- ---------------------------------------------------------------------------
-- qdit_webhook_events
-- ---------------------------------------------------------------------------

create table public.qdit_webhook_events (
  -- The event's id: the idempotency key (section 9).
  id           uuid primary key,
  event        text not null check (char_length(event) between 1 and 100),
  project_id   uuid not null,
  milestone_id uuid not null,
  -- qdit's milestone_status as the body had it: a preview, never trusted.
  status       text not null check (status in ('proposed', 'submitted', 'approved', 'rejected')),
  occurred_at  timestamptz not null,
  received_at  timestamptz not null default now(),
  -- Set once the event was acted on. A delivery that failed half-way (the
  -- chain could not be read) leaves it null, and qdit's retry acts again.
  processed_at timestamptz,
  -- Deliveries of this id seen so far.
  attempts     integer not null default 1 check (attempts >= 1)
);

comment on table public.qdit_webhook_events is
  'qdit webhook events doqtri acted on, by event id (WP-2.8, R-09). Service role only; kept 30 days.';

create index qdit_webhook_events_received_idx on public.qdit_webhook_events (received_at);

alter table public.qdit_webhook_events enable row level security;

-- No policy, and no privilege either: the webhook route is the only reader
-- and writer, with the service role.
revoke all on table public.qdit_webhook_events from public, anon, authenticated;
grant select, insert, update, delete on table public.qdit_webhook_events to service_role;


-- ---------------------------------------------------------------------------
-- qdit_milestone_states
-- ---------------------------------------------------------------------------

create table public.qdit_milestone_states (
  milestone_id     uuid primary key,
  project_id       uuid not null,
  -- What qdit last said, from an event or GET /milestones/{id}: a preview
  -- the panel may show beside the chain's answer, never what it suggests from.
  qdit_status      text check (qdit_status in ('proposed', 'submitted', 'approved', 'rejected')),
  qdit_status_at   timestamptz,
  -- The last chain read. `unregistered`: the project has no chain yet, so
  -- there was nothing to read (the heading stays Planned, section 10).
  -- `none`: the contract has no record of the milestone (MilestoneNotFound).
  -- Otherwise milestone_proof's MilestoneStatus and the record's version.
  -- The version is a u32, so bigint (integer stops at 2^31 - 1).
  chain_status     text check (chain_status in ('unregistered', 'none', 'Proposed', 'Submitted', 'Approved', 'Rejected')),
  chain_network    text check (chain_network in ('testnet', 'mainnet')),
  chain_contract_id text check (chain_contract_id ~ '^C[A-Z2-7]{55}$'),
  chain_version    bigint check (chain_version between 1 and 4294967295),
  -- The ledger the read saw (the RPC's latest ledger): orders reads.
  chain_ledger     bigint check (chain_ledger >= 0),
  chain_checked_at timestamptz,
  -- When qdit's API was last asked about the milestone (a re-check).
  qdit_checked_at  timestamptz,
  updated_at       timestamptz not null default now(),
  constraint qdit_milestone_states_chain_read check (
    case
      when chain_status is null then chain_network is null and chain_contract_id is null
        and chain_version is null and chain_ledger is null and chain_checked_at is null
      when chain_status = 'unregistered' then chain_network is null and chain_contract_id is null
        and chain_version is null and chain_checked_at is not null
      when chain_status = 'none' then chain_network is not null and chain_contract_id is not null
        and chain_version is null and chain_ledger is not null and chain_checked_at is not null
      else chain_network is not null and chain_contract_id is not null
        and chain_version is not null and chain_ledger is not null and chain_checked_at is not null
    end
  ),
  constraint qdit_milestone_states_qdit_status check ((qdit_status is null) = (qdit_status_at is null))
);

comment on table public.qdit_milestone_states is
  'Per linked qdit milestone: qdit''s last word and the last milestone_proof read (WP-2.8, D-04, D-19).';

alter table public.qdit_milestone_states enable row level security;

create policy "qdit milestone states - select as viewer" on public.qdit_milestone_states
  for select to authenticated
  using (exists (
    select 1
      from public.node_links n
      join public.documents d on d.id = n.document_id
     where n.provider = 'qdit'
       and n.qdit_milestone_id = milestone_id
       and public.is_workspace_member(d.workspace_id, 'viewer')
  ));

revoke all on table public.qdit_milestone_states from public, anon, authenticated;
grant select on table public.qdit_milestone_states to authenticated;
grant select, insert, update, delete on table public.qdit_milestone_states to service_role;

-- A milestone's state goes with its link: unlinking (one heading, or the
-- whole note through the project's cascade) leaves nothing behind that a
-- later link to the same milestone could show before it is read again.
create function public.forget_qdit_milestone_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.qdit_milestone_states s
   where s.milestone_id = old.qdit_milestone_id
     and not exists (
       select 1 from public.node_links n
        where n.provider = 'qdit' and n.qdit_milestone_id = old.qdit_milestone_id
     );
  return null;
end;
$$;

revoke all on function public.forget_qdit_milestone_state() from public, anon, authenticated;

create trigger node_links_forget_qdit_milestone_state
  after delete on public.node_links
  for each row when (old.provider = 'qdit')
  execute function public.forget_qdit_milestone_state();


-- ---------------------------------------------------------------------------
-- doc_project_links: the project's chain
-- ---------------------------------------------------------------------------

alter table public.doc_project_links
  add column chain_network     text check (chain_network in ('testnet', 'mainnet')),
  add column chain_contract_id text check (chain_contract_id ~ '^C[A-Z2-7]{55}$'),
  add constraint doc_project_links_chain check ((chain_network is null) = (chain_contract_id is null));

comment on column public.doc_project_links.chain_contract_id is
  'The project''s milestone_proof contract as qdit last reported it (section 7), null until it is registered (WP-2.8).';


-- ---------------------------------------------------------------------------
-- Functions (service role only)
-- ---------------------------------------------------------------------------

-- Notes a webhook delivery before it is acted on. Answers
--   'new'    first delivery of this id: act on it
--   'retry'  seen before but never finished (the chain could not be read):
--            act on it again
--   'done'   already acted on: answer 200 and do nothing (section 9, step 5)
-- and drops events older than 30 days, comfortably past the 7 days the
-- contract asks for and the ~22 hours qdit retries for.
create function public.claim_qdit_webhook_event(
  p_id           uuid,
  p_event        text,
  p_project_id   uuid,
  p_milestone_id uuid,
  p_status       text,
  p_occurred_at  timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_processed timestamptz;
begin
  delete from public.qdit_webhook_events e
   where e.received_at < now() - interval '30 days';

  insert into public.qdit_webhook_events (id, event, project_id, milestone_id, status, occurred_at)
  values (p_id, p_event, p_project_id, p_milestone_id, p_status, p_occurred_at)
  on conflict (id) do nothing;
  if found then
    return 'new';
  end if;

  update public.qdit_webhook_events e
     set attempts = e.attempts + 1
   where e.id = p_id
  returning e.processed_at into v_processed;
  return case when v_processed is null then 'retry' else 'done' end;
end;
$$;

comment on function public.claim_qdit_webhook_event(uuid, text, uuid, uuid, text, timestamptz) is
  'Records a qdit webhook delivery by event id: new, retry or done (WP-2.8, section 9).';

-- Records what doqtri learned about a linked milestone, from a webhook or a
-- re-check, and marks the webhook event (p_event_id) as acted on. Answers
-- 'unlinked' when no heading links the milestone in that project (the event
-- is then acted on by being ignored, section 9 step 6), else 'recorded'.
--
-- Each half is optional and guarded on its own:
--   p_qdit_status, p_qdit_status_at   kept unless a newer one is already in
--   p_chain_status ...                kept unless a read at a later ledger is
--                                     already in, or it is a read of another
--                                     contract (the project's chain changed)
-- p_qdit_checked stamps qdit_checked_at (a re-check asked qdit's API).
create function public.record_qdit_milestone_state(
  p_project_id        uuid,
  p_milestone_id      uuid,
  p_qdit_status       text default null,
  p_qdit_status_at    timestamptz default null,
  p_chain_status      text default null,
  p_chain_network     text default null,
  p_chain_contract_id text default null,
  p_chain_version     bigint default null,
  p_chain_ledger      bigint default null,
  p_qdit_checked      boolean default false,
  p_event_id          uuid default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state public.qdit_milestone_states%rowtype;
  v_qdit  boolean;
  v_chain boolean;
begin
  if (p_qdit_status is null) <> (p_qdit_status_at is null) then
    raise exception 'p_qdit_status and p_qdit_status_at go together' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.node_links n
     where n.provider = 'qdit'
       and n.qdit_milestone_id = p_milestone_id
       and n.qdit_project_id = p_project_id
  ) then
    update public.qdit_webhook_events e set processed_at = now()
     where e.id = p_event_id and e.processed_at is null;
    return 'unlinked';
  end if;

  insert into public.qdit_milestone_states (milestone_id, project_id)
  values (p_milestone_id, p_project_id)
  on conflict (milestone_id) do nothing;

  -- One writer at a time per milestone, so the guards compare against what
  -- is really there.
  select * into v_state
    from public.qdit_milestone_states s
   where s.milestone_id = p_milestone_id
     for update;

  v_qdit := p_qdit_status is not null
    and (v_state.qdit_status_at is null or p_qdit_status_at >= v_state.qdit_status_at);
  v_chain := p_chain_status is not null
    and (
      v_state.chain_status is null
      or v_state.chain_ledger is null
      or p_chain_ledger is null
      or p_chain_ledger >= v_state.chain_ledger
      or p_chain_network is distinct from v_state.chain_network
      or p_chain_contract_id is distinct from v_state.chain_contract_id
    );

  update public.qdit_milestone_states s
     set project_id        = p_project_id,
         qdit_status       = case when v_qdit then p_qdit_status else s.qdit_status end,
         qdit_status_at    = case when v_qdit then p_qdit_status_at else s.qdit_status_at end,
         chain_status      = case when v_chain then p_chain_status else s.chain_status end,
         chain_network     = case when v_chain then p_chain_network else s.chain_network end,
         chain_contract_id = case when v_chain then p_chain_contract_id else s.chain_contract_id end,
         chain_version     = case when v_chain then p_chain_version else s.chain_version end,
         chain_ledger      = case when v_chain then p_chain_ledger else s.chain_ledger end,
         chain_checked_at  = case when v_chain then now() else s.chain_checked_at end,
         qdit_checked_at   = case when p_qdit_checked then now() else s.qdit_checked_at end,
         updated_at        = now()
   where s.milestone_id = p_milestone_id;

  update public.qdit_webhook_events e set processed_at = now()
   where e.id = p_event_id and e.processed_at is null;
  return 'recorded';
end;
$$;

comment on function public.record_qdit_milestone_state(uuid, uuid, text, timestamptz, text, text, text, bigint, bigint, boolean, uuid) is
  'Records a linked qdit milestone''s state, newest wins, and marks its webhook event done (WP-2.8, D-25).';

revoke all on function public.claim_qdit_webhook_event(uuid, text, uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_qdit_webhook_event(uuid, text, uuid, uuid, text, timestamptz) to service_role;
revoke all on function public.record_qdit_milestone_state(uuid, uuid, text, timestamptz, text, text, text, bigint, bigint, boolean, uuid) from public, anon, authenticated;
grant execute on function public.record_qdit_milestone_state(uuid, uuid, text, timestamptz, text, text, text, bigint, bigint, boolean, uuid) to service_role;
