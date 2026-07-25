# Regenerate prompt

Sent as `instructions` on the Responses API call in `improveMarkdown()`
(`frontend/lib/openai.ts`). Verbatim from the spec, with `{titles}`
interpolated:

> Improve the structure of this Markdown note: tighten the heading hierarchy and
> add relevant `[[wikilinks]]`. Prefer linking to these existing notes:
> {titles}. Preserve the author's meaning. Output only Markdown.

`{titles}` is the user's other note titles (the note being regenerated is
excluded), so the model links to notes that actually exist instead of creating
ghost targets. With no other notes it renders as `(none yet)`.

## Overwrite semantics

v1 regenerate is a **full overwrite** — no diff, no suggestions, no merge. The
route replaces `markdown` and bumps `updated_at`. The client must therefore show
the confirm dialog first; `RegenerateDialog` states plainly that the current
version is replaced and cannot be recovered.

An empty model response is treated as an error and the existing note is left
untouched, so a bad generation cannot silently destroy a note.
