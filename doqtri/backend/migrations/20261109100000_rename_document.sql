-- Renames a note, with its title heading when that changes too (DOQ-35, WP-1.7).
--
-- A note usually opens with `# <title>`, and the mindmap folds that heading
-- into its root only while it matches the title (DOQ-30). /api/notes/[id]
-- (PATCH) therefore rewrites a first-line `# <old title>` to `# <new title>`
-- when the note is renamed (lib/title-heading.ts decides whether the heading
-- is the title's), and rename_document() below writes the new title and, when
-- given, that new text in one UPDATE as the caller.
--
-- It replaces the route's service-role UPDATE, whose lock check was a
-- separate read: a teammate could take the lock between that read and the
-- write. Here the document row and its lock row are both locked first, so
-- the checks and the write are one step.
--
-- rename_document() rules:
--   * The caller must be an editor or above of the note's workspace, as for
--     save_document().
--   * A title is one line: not blank, and no control character
--     (U+0001-U+001F, U+007F), the same class as hasControlCharacters() in
--     lib/title.ts. NUL cannot occur in text.
--   * Someone else holding a live lock refuses any rename, as before: they are
--     typing into the note and would not see it.
--   * A rename that rewrites the text is an edit (D-17). It needs the lock
--     free, or held by the caller from p_session, the editor tab that asked;
--     held by the caller from another tab, it is refused, or that tab's next
--     save would find the note moved on and stop on a conflict. A lapsed
--     lock, the caller's own included, counts as free.
--   * The text may change only in its title heading: p_markdown must be the
--     stored text with its first non-blank line replaced by exactly
--     `# <title>` (title_heading_rewrite() below), every other byte, line
--     endings included, as stored. So the function is not a second way to
--     save arbitrary text past save_document()'s checks and the route's
--     after-save hook.
--   * p_base_version is required with p_markdown, and must be the note's
--     current version when given: the text was rewritten from that version.
--     The route always sends it and reads again on DQVER.
--   * A title-only rename (p_markdown null) under the caller's own lock from
--     another tab goes on, as before: the text does not change, so that tab
--     loses nothing.
--   * When the caller holds the live lock from p_session, its heartbeat is
--     renewed, as a save renews it.
--   * Title and text change in the same UPDATE, so a title another note in
--     the workspace has (the unique index) leaves both as they were.
--     documents_before_save bumps the version when the text changes.
--
-- The lock row is locked whether or not it is live, and its age is checked
-- here: a take_doc_lock() of a lapsed lock running alongside then waits for
-- this rename, and the status it answers carries the renamed version. (With
-- no lock row at all there is nothing to lock; a take that inserts one then
-- may answer the version from before the rename. The holder's editor loaded
-- its text separately and its version check still holds.)
--
-- Returns the note's version after the write.
--
-- Refused, writing nothing, with:
--   no_data_found (P0002)            the caller cannot see the note
--   insufficient_privilege (42501)   the caller is below editor
--   check_violation (23514)          a blank title, or one with a control
--                                    character
--   invalid_parameter_value (22023)  text without its base version, or text
--                                    that differs from the stored text by
--                                    more than the title heading
--   DQLCK, detail 'other'            another user holds the lock
--   DQLCK, detail 'elsewhere'        the caller holds it from another session,
--                                    and the text would change
--   DQVER, detail <version>          p_base_version is not the current version
--   unique_violation (23505)         another note in the workspace has the title
--
-- The same migration stops clients changing a title directly: the WP-1.2
-- policy "workspace docs - update as editor" lets an editor update any column
-- RLS covers, so a plain UPDATE of `title` would skip the lock and one-line
-- rules above. documents_before_update() is replaced with its earlier body
-- unchanged plus that refusal. The service role and SECURITY DEFINER
-- functions (rename_document() among them) are not stopped by it.
--
-- No CHECK constraint on titles: imported notes take their title from the
-- file's first heading or its filename (deriveTitle()), which are not
-- length-capped and may hold tabs, so one could refuse an upload that works
-- today.


-- `p_markdown` with its first non-blank line replaced by `# <btrim(p_title)>`,
-- every other byte kept: the line's own `\r` of a CRLF ending, the lines
-- before it (blank ones) and everything after it. Null when every line is
-- blank, and null when that first non-blank line is not an ATX level-1
-- heading (`#` then a space or tab): it only ever rewrites a `# ` heading
-- line, never prose or a `## ` heading. A blank line holds only spaces, tabs,
-- form feeds and vertical tabs (and its `\r`). Internal: only
-- rename_document() calls it.
create function public.title_heading_rewrite(p_markdown text, p_title text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_len  int := length(p_markdown);
  v_pos  int := 1;
  v_rel  int;
  v_end  int;
  v_line text;
begin
  if p_markdown is null or p_title is null then
    return null;
  end if;
  while v_pos <= v_len loop
    v_rel := strpos(substr(p_markdown, v_pos), E'\n');
    v_end := case when v_rel = 0 then v_len + 1 else v_pos + v_rel - 1 end;
    v_line := substr(p_markdown, v_pos, v_end - v_pos);
    if right(v_line, 1) = E'\r' then
      v_line := left(v_line, -1);
    end if;
    if v_line !~ E'^[ \\t\\f\\v]*$' then
      if v_line !~ E'^#[ \\t]' then
        return null;
      end if;
      return substr(p_markdown, 1, v_pos - 1)
          || '# ' || btrim(p_title)
          || substr(p_markdown, v_pos + length(v_line));
    end if;
    exit when v_rel = 0;
    v_pos := v_end + 1;
  end loop;
  return null;
end;
$$;

revoke execute on function public.title_heading_rewrite(text, text) from public, anon, authenticated;


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
  v_live    boolean;
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
  if p_title is null or btrim(p_title) = '' or p_title ~ E'[\\x01-\\x1f\\x7f]' then
    raise exception 'a note''s title is one line of text'
      using errcode = 'check_violation';
  end if;
  if p_markdown is not null and p_base_version is null then
    raise exception 'a rename that changes the text needs the version it was read at'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Locked live or lapsed; its age is decided here.
  select l.holder, l.session_id, l.heartbeat_at into v_lock
    from public.doc_locks l
   where l.document_id = p_document_id
     for update;
  v_live := v_lock.holder is not null
        and v_lock.heartbeat_at > now() - public.doc_lock_idle_timeout();

  if v_live and v_lock.holder <> v_uid then
    raise exception 'someone else is editing this note'
      using errcode = 'DQLCK', detail = 'other';
  end if;
  if p_markdown is not null and v_live and v_lock.session_id is distinct from p_session then
    raise exception 'you are editing this note in another tab or window'
      using errcode = 'DQLCK', detail = 'elsewhere';
  end if;

  if p_base_version is not null and p_base_version is distinct from v_doc.version then
    raise exception 'this note was saved since it was read (version % now, given %)',
      v_doc.version, p_base_version
      using errcode = 'DQVER', detail = v_doc.version::text;
  end if;

  if p_markdown is not null
     and p_markdown is distinct from public.title_heading_rewrite(v_doc.markdown, p_title) then
    raise exception 'markdown may only change the title heading'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_live and v_lock.session_id = p_session then
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


-- 20261024130000_workspace_document_ownership.sql's body, unchanged, with one
-- refusal added at the end: a client role may not change `title`. Renames go
-- through rename_document() above.
create or replace function public.documents_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and (new.user_id is distinct from old.user_id
          or new.workspace_id is distinct from old.workspace_id)
  then
    raise exception 'a document''s author and workspace cannot be changed'
      using errcode = 'check_violation';
  end if;
  if current_user in ('anon', 'authenticated')
     and new.publish_headings is distinct from old.publish_headings
     and (current_user = 'anon'
          or not public.is_workspace_member(old.workspace_id, 'admin'))
  then
    raise exception 'only an admin of the workspace can change whether headings are public'
      using errcode = 'insufficient_privilege';
  end if;
  if current_user in ('anon', 'authenticated')
     and new.title is distinct from old.title
  then
    raise exception 'a note''s title is changed through rename_document(), which checks the edit lock'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
