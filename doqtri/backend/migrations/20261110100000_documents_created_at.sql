-- When a note was created (WP-4.7, DOQ-39, D-117).
--
-- documents had only updated_at, so nothing could tell a note written during
-- an event from one written weeks before and edited once. The hackathon
-- snapshot doqtri pushes to qdit (lib/integrations/qdit-hackathon.ts) sends
-- each note's created_at, and qdit's eligibility check counts only notes
-- created inside the event window.
--
--   created_at   timestamptz, not null, default now(). Every note that
--                exists when this migration runs gets the time it ran: the
--                true creation time is lost. This migration MUST therefore
--                be applied before any hackathon opens. Then every
--                pre-existing note reads as created before the event, and
--                none can count as written during it.
--
-- A client role (anon, authenticated) cannot choose or change it: an insert
-- is stamped with now() whatever it sends, and an update that changes it is
-- refused, the way documents_before_update refuses a new author or
-- workspace. Without that, an editor could backdate or postdate a note with
-- a plain UPDATE, since the update policies let editors write whole rows.
-- The service role and the table owner may still set it (a restore, a
-- move).
--
-- Everything else that touches documents was checked and keeps working:
--
--   policies (select/insert/update/delete)   unchanged; they name no
--                                            columns.
--   documents_before_insert                  unchanged (publish_headings).
--   documents_before_update                  unchanged (author, workspace,
--                                            publish_headings).
--   documents_before_save                    unchanged; adding the column
--                                            updates no row, so no version
--                                            moves.
--   delete triggers                          unchanged.
--   save_document()                          writes markdown and updated_at
--                                            only.
--   RPCs and views                           none returns documents.* or a
--                                            fixed documents column list, so
--                                            none needs a new column.
--   frontend inserts                         insertWorkspaceDocument() runs
--                                            as the service role and names no
--                                            created_at, so the default
--                                            applies. No client sends it.
--
-- Deploy order: migration first, then code. loadVaultDocs() and the snapshot
-- builder select created_at, so the vault pages fail on a database without
-- the column. Not applied to the hosted project by this change: the product
-- owner applies it, before the code that selects it is deployed and before
-- any hackathon opens.

-- now() is stable, so Postgres stores it as the column's fast default: no
-- table rewrite, no UPDATE of existing rows, no trigger fires, and every
-- existing row reads the time this statement ran.
alter table public.documents add column if not exists created_at timestamptz not null default now();

-- Not security definer: current_user must be the writer's own role. It reads
-- no tables.
create function public.documents_created_at_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.created_at := now();
    elsif new.created_at is distinct from old.created_at then
      raise exception 'a note''s creation time cannot be changed'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger documents_created_at_guard
  before insert or update on public.documents
  for each row execute function public.documents_created_at_guard();

revoke execute on function public.documents_created_at_guard() from public, anon, authenticated;
