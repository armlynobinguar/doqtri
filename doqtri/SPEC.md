# Mindmap App — Build Spec

A note-taking app in the shape of Obsidian: ingest any document, convert it to markdown, and project an editable knowledge graph from the `[[wikilinks]]` inside that markdown. AI seeds the structure and links; the user owns the markdown from then on.

This is the **v1 fast-path spec**. Build exactly what's here. The "Non-goals" section lists things that were deliberately deferred — do not build them.

---

## Product summary

- User uploads a document (PDF, DOCX, PPTX, TXT).
- The app converts it to clean markdown via OpenAI's file input, with `#` headings for structure and `[[wikilinks]]` on key concepts.
- The markdown is the **single source of truth**. The user edits it freely in an Obsidian-style editor.
- Two graph views are **derived deterministically from the markdown** — never stored, never stale:
  - **Global graph** — every note is a node; every `[[link]]` is an edge. Missing targets render as "ghost" nodes.
  - **Per-document mindmap** — a tree built from that note's heading hierarchy.
- A **Regenerate** button re-runs the AI over a note to improve structure and links. v1 regenerate is a **full overwrite behind a confirm dialog**.

---

## Tech stack (pinned)

- **Framework:** Next.js (App Router, TypeScript, strict mode)
- **UI:** shadcn/ui + Tailwind CSS
- **Backend:** Supabase (Postgres, Auth, Storage)
- **Ingestion:** OpenAI API file input (vision-capable model)
- **Graph:** `react-force-graph-2d`
- **Editor:** `@uiw/react-md-editor` (edit + live preview; minimal setup)
- **Deploy:** Vercel

Ingestion runs inside a Next.js API route for v1 — small documents fit within serverless limits. If large-file timeouts appear, the fix is a separate worker, but **do not build that in v1.**

---

## Non-goals (v1) — do NOT build these

- No embeddings, no pgvector, no vector search.
- No `concepts` table, no entity resolution, no concept deduplication.
- No diff/suggest regenerate, no link provenance, no three-way merge. Regenerate is full overwrite only.
- No separate ingestion worker / queue.
- No stored graph tables. The graph is always parsed from markdown at render time.
- No real-time collaboration, no sharing, no mobile layout.

Keeping the graph derived and the schema at one table is the whole point of the fast path. Adding any of the above breaks the "no staleness" guarantee and multiplies scope.

---

## Setup

```bash
npx create-next-app@latest mindmap-app --typescript --tailwind --app --eslint
cd mindmap-app

npx shadcn@latest init

# shadcn components used by this app
npx shadcn@latest add button dialog input tabs tooltip sonner \
  scroll-area separator dropdown-menu command sidebar resizable

npm install react-force-graph-2d @uiw/react-md-editor
npm install @supabase/supabase-js @supabase/ssr openai
```

### Environment variables (`.env.local`)

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=      # server-side only, never exposed to client
OPENAI_API_KEY=                 # server-side only
OPENAI_MODEL=gpt-4o             # any current vision-capable model
```

---

## Data model (Supabase)

One table. Run in the Supabase SQL editor.

```sql
create table public.documents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text not null,
  markdown   text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.documents enable row level security;

create policy "own docs - select" on public.documents
  for select using (auth.uid() = user_id);
create policy "own docs - insert" on public.documents
  for insert with check (auth.uid() = user_id);
create policy "own docs - update" on public.documents
  for update using (auth.uid() = user_id);
create policy "own docs - delete" on public.documents
  for delete using (auth.uid() = user_id);

create index documents_user_title_idx
  on public.documents (user_id, lower(title));
```

Create a **private Storage bucket** named `uploads` for the original files (kept for reference; markdown is what the app uses). The graph is computed client-side from the user's fetched documents, so no graph tables exist.

---

## Core algorithms

### 1. Ingestion — `app/api/ingest/route.ts`

Server route. Receives an uploaded file, sends it to OpenAI file input, stores the returned markdown as a new `documents` row.

System prompt:

> Convert this document to clean, faithful Markdown. Use `#`/`##`/`###` headings to reflect the document's structure. Wrap key concepts and named entities in `[[double brackets]]`, and add `[[wikilinks]]` between clearly related topics. Do not invent content. Output only Markdown, no commentary.

Insert with the service-role key server-side, setting `user_id` from the authenticated session. Return the new `id`.

### 2. Wikilink parser — `lib/wikilinks.ts`

Deterministic. This is the whole graph engine.

```ts
// Matches [[Title]] and [[Title|alias]]; captures Title only.
const LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

type Doc = { id: string; title: string; markdown: string };
type GraphNode = { id: string; label: string; ghost: boolean };
type GraphEdge = { source: string; target: string };

export function parseLinks(markdown: string): string[]; // trimmed target titles
export function buildGraph(docs: Doc[]): { nodes: GraphNode[]; edges: GraphEdge[] };
```

`buildGraph` contract:

- Build a `lower(trim(title)) -> docId` map over all docs.
- Nodes: one per document (`ghost: false`). For any link target with no matching title, add a ghost node keyed by the normalized title (`ghost: true`), created once.
- Edges: for each doc, for each parsed link → edge from that doc's id to the resolved doc id or the ghost node id.
- De-duplicate nodes and edges. Title matching is case-insensitive and trim-insensitive.

### 3. Per-document mindmap — `lib/mindmap.ts`

```ts
type MindmapNode = { id: string; label: string; children: MindmapNode[] };
export function buildMindmap(title: string, markdown: string): MindmapNode;
```

Root = document title. Walk markdown lines; each `#`-prefixed heading becomes a node nested by its level (`##` is a child of the nearest preceding `#`, etc.). Non-heading lines are ignored in v1.

### 4. Regenerate — `app/api/regenerate/route.ts`

Server route. Takes a document id, loads its current markdown, sends it to OpenAI along with **the list of existing note titles for that user** so the model links to real notes.

System prompt:

> Improve the structure of this Markdown note: tighten the heading hierarchy and add relevant `[[wikilinks]]`. Prefer linking to these existing notes: {titles}. Preserve the author's meaning. Output only Markdown.

**Full overwrite:** replace `markdown` on the row, bump `updated_at`. The client must show a confirm dialog ("This replaces your current version") before calling, and a toast on success.

---

## UI

Obsidian's three-pane layout, painted in Cursor's dark palette, built from shadcn primitives.

### Layout

- **Ribbon** (44px, far left): icon rail — files, search, graph, settings. Use `Tooltip` on each.
- **File explorer** (~210px): `Sidebar` + `ScrollArea`, folder/file tree of the user's notes. Active note gets a left accent border.
- **Editor** (flex center): `Tabs` for open notes; `@uiw/react-md-editor` below. This is the source of truth.
- **Right panel** (~250px): `Tabs` toggling **Graph** (`react-force-graph-2d`) and **Mindmap**; a backlinks list below.
- **Status bar** (24px): note count, word count, theme name.

Use `Resizable` panels between explorer / editor / right panel. `Command` (⌘K) gives an Obsidian-style quick switcher. `react-force-graph-2d` and `@uiw/react-md-editor` both touch `window` — import them with `next/dynamic` and `{ ssr: false }`.

### Cursor dark theme

Force dark mode app-wide and override shadcn's CSS variables in `globals.css`. HSL channel values below correspond to the Cursor palette from the approved mockup.

```css
.dark {
  --background: 0 0% 12%;          /* #1e1e1e editor / app */
  --foreground: 0 0% 83%;          /* #d4d4d4 primary text */
  --card: 0 0% 12%;
  --card-foreground: 0 0% 83%;
  --popover: 0 0% 8%;              /* #141414 */
  --popover-foreground: 0 0% 83%;
  --primary: 213 100% 65%;         /* #4d9dff accent */
  --primary-foreground: 0 0% 100%;
  --secondary: 0 0% 14%;           /* #232323 active row */
  --secondary-foreground: 0 0% 83%;
  --muted: 0 0% 9%;                /* #181818 sidebars */
  --muted-foreground: 0 0% 50%;    /* #808080 */
  --accent: 264 100% 82%;          /* #c8a2ff secondary / AI actions */
  --accent-foreground: 0 0% 12%;
  --border: 0 0% 16%;              /* #2a2a2a hairlines */
  --input: 0 0% 16%;
  --ring: 213 100% 65%;

  --sidebar-background: 0 0% 9%;   /* #181818 */
  --sidebar-foreground: 0 0% 60%;
  --sidebar-primary: 213 100% 65%;
  --sidebar-accent: 0 0% 14%;
  --sidebar-border: 0 0% 16%;
}
```

Design rules for Claude Code to hold to:

- One accent (`#4d9dff`) only: active file marker, tab underline, `[[wikilinks]]`, resolved graph nodes. Never introduce a second UI accent.
- Reserve the purple (`#c8a2ff`) exclusively for AI-driven affordances (the Regenerate control, "AI-generated" markers).
- Ghost nodes render hollow (stroke, no fill) and dimmed, like Obsidian's unresolved links.
- Low contrast on purpose: muted text at `#808080`, section labels at `#5a5a5a`.

> If the project is on Tailwind v4 / the oklch shadcn theme, keep the same semantic mapping and convert these HSL values to your theme format rather than changing which token maps to which color.

---

## File structure

```
app/
  layout.tsx                 # forces .dark, Sonner toaster
  page.tsx                   # redirect -> /vault or /login
  (auth)/login/page.tsx
  vault/
    layout.tsx               # ribbon + explorer + resizable shell
    [docId]/page.tsx         # editor + right panel for one note
  api/
    ingest/route.ts
    regenerate/route.ts
components/
  vault/{ribbon,file-explorer,editor-pane,graph-panel,mindmap-panel,status-bar,regenerate-dialog,upload-dialog}.tsx
  ui/                        # shadcn generated
lib/
  supabase/{client,server}.ts
  wikilinks.ts               # parseLinks, buildGraph
  mindmap.ts                 # buildMindmap
  openai.ts                  # ingest + regenerate helpers
```

---

## Build order & acceptance criteria

Each milestone is independently testable. There's a working app from M3 onward.

**M0 — Scaffold & theme.** Next + shadcn installed, dark mode forced, Cursor CSS variables applied. *Done when:* the empty three-pane shell renders in Cursor colors and resizes.

**M1 — Auth & Supabase.** Supabase clients wired, email auth, `documents` table + RLS live. *Done when:* a signed-in user can create and read only their own rows.

**M2 — Upload & ingest.** Upload dialog → `uploads` bucket → `/api/ingest` → markdown row. *Done when:* uploading a PDF produces a new note whose markdown has headings and `[[wikilinks]]`.

**M3 — Editor & save.** File explorer lists notes; selecting one opens it in the md editor; edits persist (debounced) to Supabase. *Done when:* an edit survives reload.

**M4 — Graph.** `lib/wikilinks.ts` implemented and unit-tested; `graph-panel.tsx` renders the global graph with ghost nodes; clicking a node opens that note. *Done when:* adding `[[Foo]]` in the editor makes a Foo node appear on next render.

**M5 — Mindmap.** `lib/mindmap.ts` implemented; mindmap tab renders the heading tree for the active note. *Done when:* editing headings changes the tree.

**M6 — Regenerate.** Regenerate button → confirm dialog → `/api/regenerate` → overwrite → toast. *Done when:* regenerating rewrites structure and the graph re-derives from the new markdown.

---

## Conventions & guardrails

- TypeScript strict. No `any` in `lib/`.
- `OPENAI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are server-only — never referenced in a client component or a `NEXT_PUBLIC_` var.
- Client components use the anon key with RLS; privileged inserts happen in API routes with the service role, always stamping `user_id` from the verified session.
- The graph is always computed from markdown at render time. Never persist nodes or edges.
- Keep the schema at one table. If a feature seems to need a second table, it's a v2 non-goal — stop and flag it.
- `react-force-graph-2d` and `@uiw/react-md-editor` must be dynamically imported with `{ ssr: false }`.
