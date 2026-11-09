-- Renames a note, with its title heading when that changes too (DOQ-35, WP-1.7).
--
-- A note usually opens with `# <title>`, and the mindmap folds that heading
-- into its root only while it matches the title (DOQ-30). /api/notes/[id]
-- (PATCH) therefore rewrites a first-line `# <old title>` to `# <new title>`
-- when the note is renamed (lib/title-heading.ts), and this function writes
-- the new title and, when given, that new text in one UPDATE as the caller.
--
-- It replaces the route's service-role UPDATE, whose lock check was a
-- separate read: a teammate could take the lock between that read and the
-- write. Here the document row and its lock row are both locked first, so
-- the checks and the write are one step.
--
-- Rules:
--   * The caller must be an editor or above of the note's workspace, as for
--     save_document().
--   * Someone else holding a live lock refuses any rename, as before: they are
--     typing into the note and would not see it.
--   * A rename that rewrites the text is an edit (D-17). It needs the lock
--     free, or held by the caller from p_session, the editor tab that asked;
--     held by the caller from another tab, it is refused, or that tab's next
--     save would find the note moved on and stop on a conflict. When the
--     caller holds it from p_session, the heartbeat is renewed, as a save
--     renews it.
--   * A title-only rename (p_markdown null) under the caller's own lock from
--     another tab goes on, as before: the text does not change, so that tab
--     loses nothing.
--   * p_base_version, when given, must be the note's current version: the
--     text was rewritten from that version. The route always sends it and
--     reads again on DQVER.
--   * Title and text change in the same UPDATE, so a title another note in
--     the workspace has (the unique index) leaves both as they were.
--     documents_before_save bumps the version when the text changes.
--
-- Returns the note's version after the write.
--
-- Refused, writing nothing, with:
--   no_data_found (P0002)           the caller cannot see the note
--   insufficient_privilege (42501)  the caller is below editor
--   check_violation (23514)         a blank title, or one with control
--                                   characters (a title is one line)
--   DQLCK, detail 'other'           another user holds the lock
--   DQLCK, detail 'elsewhere'       the caller holds it from another session,
--                                   and the text would change
--   DQVER, detail <version>         p_base_version is not the current version
--   unique_violation (23505)        another note in the workspace has the title

create function public.rename_document(
  p_document_id  uuid,
  p_title        text,
  p_markdown     text,
  p_base_version bigint,
  p_session      uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_doc     record;
  v_lock    record;
  v_version bigint;
begin
  select d.id, d.workspace_id, d.markdown, d.version into v_doc
    from public.documents d
   where d.id = p_document_id
     for update;
  if v_doc.id is null or v_uid is null or not public.is_workspace_member(v_doc.workspace_id, 'viewer') then
    raise exception 'note not found' using errcode = 'no_data_found';
  end if;
  if not public.is_workspace_member(v_doc.workspace_id, 'editor') then
    raise exception 'you can read this note but not rename it'
      using errcode = 'insufficient_privilege';
  end if;
  if p_title is null or btrim(p_title) = '' or p_title ~ '[[:cntrl:]]' then
    raise exception 'a note''s title is one line of text'
      using errcode = 'check_violation';
  end if;

  select l.holder, l.session_id into v_lock
    from public.doc_locks l
   where l.document_id = p_document_id
     and l.heartbeat_at > now() - public.doc_lock_idle_timeout()
     for update;
  if v_lock.holder is not null and v_lock.holder <> v_uid then
    raise exception 'someone else is editing this note'
      using errcode = 'DQLCK', detail = 'other';
  end if;
  if p_markdown is not null and v_lock.holder is not null
     and v_lock.session_id is distinct from p_session then
    raise exception 'you are editing this note in another tab or window'
      using errcode = 'DQLCK', detail = 'elsewhere';
  end if;

  if p_base_version is not null and p_base_version is distinct from v_doc.version then
    raise exception 'this note was saved since it was read (version % now, given %)',
      v_doc.version, p_base_version
      using errcode = 'DQVER', detail = v_doc.version::text;
  end if;

  if v_lock.holder is not null and v_lock.session_id = p_session then
    update public.doc_locks l
       set heartbeat_at = now()
     where l.document_id = p_document_id;
  end if;

  update public.documents d
     set title = p_title,
         markdown = coalesce(p_markdown, d.markdown),
         updated_at = case
           when p_markdown is not null and p_markdown is distinct from d.markdown then now()
           else d.updated_at
         end
   where d.id = p_document_id
  returning d.version into v_version;
  return v_version;
end;
$$;

revoke execute on function public.rename_document(uuid, text, text, bigint, uuid) from public, anon;
grant execute on function public.rename_document(uuid, text, text, bigint, uuid) to authenticated;
