# Mindmap

A note-taking app in the shape of Obsidian: ingest any document, convert it to
markdown, and project an editable knowledge graph from the `[[wikilinks]]`
inside that markdown. AI seeds the structure and links; you own the markdown
from then on.

Built to [`SPEC.md`](./SPEC.md) — the v1 fast-path spec.

## The one idea

The markdown is the single source of truth. Both views are **derived from it at
render time and never stored**:

- **Global graph** — every note is a node, every `[[link]]` an edge. Link
  targets with no matching note render as hollow "ghost" nodes.
- **Per-document mindmap** — a tree built from the note's heading hierarchy.

That is why there is exactly one table and no graph schema. Nothing can go
stale, because there is nothing to keep in sync.

## Layout

```
frontend/          Next.js app (App Router, TypeScript strict)
  app/
    (auth)/login/  email + password
    vault/         layout = ribbon + explorer; [docId] = editor + right panel
    api/           ingest, regenerate
  components/
    vault/         ribbon, explorer, editor, graph, mindmap, dialogs
    ui/            shadcn (Base UI variant)
  lib/
    wikilinks.ts   parseLinks, buildGraph, buildBacklinks  <- the graph engine
    mindmap.ts     buildMindmap
    openai.ts      ingest + regenerate helpers
    supabase/      browser, session-bound server, service-role clients
  proxy.ts         session refresh + route guard (Next 16's middleware)
backend/
  migrations/      SQL applied to the Supabase project
  prompts/         the two AI prompts
```

## Stack

Next.js 16 · React 19 · TypeScript strict · Tailwind v4 · shadcn/ui ·
Supabase (Postgres + Auth + Storage) · OpenAI Responses API ·
`react-force-graph-2d` · `@uiw/react-md-editor` · Vitest · Playwright

Three additions to the spec's pinned list, all forced:

- **Next 16, not 15** — `create-next-app@latest` installs 16. Middleware is
  renamed to `proxy.ts` and `cookies()`/`params` are async-only, which the code
  accounts for.
- **`officeparser` added** — the spec accepts DOCX and PPTX, but OpenAI's file
  input does not. Their text is extracted locally, then sent as text. PDFs still
  go to the model as files. It is given an explicit `fileType` hint: its
  magic-byte auto-detection is unreliable from a buffer and fails outright inside
  the bundled route.
- **Vitest + Playwright added** — the spec requires the wikilink parser to be
  unit-tested but pins no runner, and the graph, editor, and dialogs can only be
  verified in a real browser.

## Setup

```bash
cd frontend
npm install
```

`.env.local` is already populated with the Supabase URL and anon key. Two
secrets are left blank because they cannot be read programmatically:

```
SUPABASE_SERVICE_ROLE_KEY=   # Dashboard -> Project Settings -> API keys
OPENAI_API_KEY=              # platform.openai.com/api-keys
```

Ingest and regenerate return a clear error until both are set. Everything else
works without them.

```bash
npm run dev       # http://localhost:3000
npm test          # 57 unit tests over lib/
npm run test:e2e  # 17 Playwright tests through a real browser
npm run build
```

`npm run test:e2e` signs in through the real login form, then seeds and cleans up
its own notes directly in Postgres — it deliberately does not call `/api/ingest`,
which would bill a live OpenAI request per test. It needs
`SUPABASE_SERVICE_ROLE_KEY` for that seeding, and reuses a dev server if one is
already running.

### Getting a login

v1 expects **email confirmation to be disabled**, so signing up through the UI
gives you a session immediately and no mail needs to be delivered. Turn it off at
*Authentication → Providers → Email → Confirm email* — it is a manual dashboard
step and cannot be scripted from the MCP server.

Until then, use the existing confirmed account:
`alice.mindmap@gmail.com` / `test-passw0rd-123`.

This means unverified addresses can register and there is no password reset —
fine for a private vault, not fine once real users exist. When that changes, see
the Resend runbook in [`backend/README.md`](../backend/README.md#runbook-turning-confirmations-back-on-with-resend).
No app code changes are needed; the login form already handles the
confirm-your-email path.

## Design

Cursor's dark palette on Obsidian's three-pane layout. The rules the code holds
to:

- **One accent** (`#4d9dff`): active file marker, tab underline, wikilinks,
  resolved graph nodes. There is no second UI accent.
- **Purple** (`#c8a2ff`) is reserved for AI affordances — the Regenerate control
  and nothing else. The active-node ring in the graph is deliberately neutral
  rather than purple for this reason.
- Ghost nodes are stroke-only and dimmed, like Obsidian's unresolved links.
- Low contrast on purpose: muted text `#808080`, section labels `#5a5a5a`.

The spec's HSL channels were converted to oklch for Tailwind v4; Lightning CSS
compiles them back to the exact source hex values.

## Not in v1

No embeddings or vector search. No concepts table or entity resolution. No
diff/suggest regenerate — it is a full overwrite behind a confirm dialog. No
ingestion worker or queue. No stored graph. No collaboration, sharing, or mobile
layout. Multi-note editor tabs are also out: the explorer and ⌘K are the
navigation model, and the tab strip shows the active note only.

Adding any of these breaks the "no staleness" guarantee or multiplies scope.
