# 001 — Document mindmap + global mindmap

**Status:** Shipped
**Opened:** 2026-07-25
**Shipped:** 2026-07-25
**Supersedes:** `SPEC.md` v1 non-goals — "no `concepts` table, no concept
deduplication" and the invariant "graph views are never stored". Both are
deliberately broken here; see [Tradeoff](#tradeoff-accepted).

---

## Problem

Uploading a single document produces almost no mindmap.

- The **Graph** tab (`components/vault/graph-panel.tsx`) is a graph *of
  documents* — nodes are notes, edges are `[[wikilinks]]`. With one document in
  the vault there is nothing to relate, so the view is empty-ish.
- The **Mindmap** tab (`components/vault/mindmap-panel.tsx`, built by
  `lib/mindmap.ts:27`) is per-document, but it is heading-only and rendered as
  an indented `<ul>`. A flat document — contract, paper, slide dump — has two or
  three headings, so it yields two or three nodes and reads as broken.

Net effect: the app maps the *relationship between* documents, not the *content
of* a document.

## Verdict

Separate section. Do not replace the Obsidian core — the vault graph, wikilinks,
backlinks, and markdown-as-source-of-truth all stay exactly as they are.

Three views, three distinct jobs:

| View | Nodes | Source | Surface |
|---|---|---|---|
| Vault graph (existing, unchanged) | documents + ghost links | wikilinks, derived at render | right-panel tab |
| **Document mindmap** (new) | concepts inside one document | LLM at ingest, stored | full route + right-panel tab |
| **Global mindmap** (new) | concepts merged across all documents | stored mindmaps + wikilinks | full route |

Heading-only extraction is retired as the *primary* source. It cannot fix the
complaint — it fails precisely on the unstructured documents that expose the
problem. It stays as the fallback when LLM extraction is missing or failed.

### Tradeoff (accepted)

Storing a mindmap breaks v1's "derived, never stored, never stale" invariant.
A semantic concept map is not deterministically derivable from markdown, so
there is no version of this feature that preserves it. Mitigation: every stored
mindmap carries a hash of the markdown it was generated from, the UI marks it
stale when the markdown moves on, and regeneration is one click.

---

## Plan

### 1. Schema

`backend/migrations/<timestamp>_add_document_mindmap.sql`

```sql
alter table public.documents
  add column mindmap      jsonb,
  add column mindmap_hash text;
```

No second table — column on `documents` keeps the single-table shape.
`mindmap_hash` is SHA-256 of the markdown at generation time.

### 2. Shape

`lib/mindmap-types.ts`

```ts
type ConceptNode = {
  id: string;
  label: string;
  kind: "root" | "theme" | "concept" | "detail";
  summary?: string;   // one line, shown on hover
  children: ConceptNode[];
};

type DocMindmap = {
  version: 1;
  root: ConceptNode;
  concepts: string[];  // flat canonical labels — the join key for global merge
};
```

### 3. Extraction

`lib/mindmap-ai.ts` — `extractMindmap({ title, markdown }): Promise<DocMindmap>`

OpenAI structured output (`json_schema`, strict). Constraints enforced in schema
and prompt: max depth 3, max 7 children per node, labels ≤ 5 words, no invented
content, and reuse existing `[[wikilink]]` terms as concept labels so the
document mindmap and the vault graph share vocabulary.

### 4. Ingest wiring

`app/api/ingest/route.ts` — second call after the markdown insert, non-fatal.
On failure `mindmap` stays null and the view falls back to `lib/mindmap.ts`
heading extraction. `maxDuration` is already 300. Adds roughly 3–8s to upload;
the upload dialog already shows progress.

### 5. Backfill + regenerate

`app/api/mindmap/route.ts` — `POST { docId }` regenerates one mindmap. Called
lazily the first time an older document opens its mindmap view, and by an
explicit "Regenerate mindmap" button when the hash is stale. `/api/regenerate`
also refreshes the mindmap, since it rewrites the markdown underneath it.

### 6. Global merge

`lib/global-mindmap.ts` — `buildGlobalMindmap(docs)`

Concept-centric graph: one node per document, one node per normalized concept
label, and a concept appearing in 2+ documents becomes a hub node (larger,
distinct color). Documents with a null mindmap fall back to their wikilink
edges, so the view degrades rather than dropping them. Reuses
`react-force-graph-2d` and `GRAPH_COLORS` from `lib/theme.ts`.

### 7. UI

- `components/vault/mindmap-canvas.tsx` — radial/tree canvas shared by both new
  views. Node click scrolls the editor to that section, or opens the owning doc.
- `app/vault/[docId]/mindmap/page.tsx` — full-screen document mindmap.
- `app/vault/mindmap/page.tsx` — full-screen global mindmap.
- `components/vault/ribbon.tsx` — new `mindmap` action routing to the global
  view; extend `RibbonAction`.
- `components/vault/right-panel.tsx` — the Mindmap tab renders the stored
  concept tree instead of headings, plus an "Open full ↗" affordance.

### 8. Tests

- Vitest: `lib/global-mindmap.test.ts` (label dedupe, hub detection,
  null-mindmap fallback); extend `lib/mindmap.test.ts` for the fallback path.
- Playwright: extend `e2e/graph-mindmap.spec.ts` — a single-document vault
  renders a real mindmap; the global route is reachable from the ribbon.
  Extraction call is mocked.

### Order

1 → 2 → 3 → 4 (upload now produces a real mindmap) → 7 document view →
5 backfill → 6 + 7 global view → 8.

---

## Decisions

- **Surface: full routes + panel tab.** `/vault/mindmap` (global, reached from
  the ribbon) and `/vault/[docId]/mindmap` (document, reached from the panel's
  "Open full ↗"). The right-panel Mindmap tab stays as a compact concept tree so
  it remains useful while editing.
- **Timing: inline during ingest.** The extraction call runs inside
  `/api/ingest` before it returns. Upload gets ~3–8s slower; in exchange there
  is no pending state, no polling, and no realtime subscription — the mindmap
  exists the moment the document opens.

## What shipped

Migration applied to project `omoalynhmtbqffogjvoy` (two nullable columns; the
nine existing rows keep `mindmap` null and fall back to headings until rebuilt).

New:

| File | Role |
|---|---|
| `backend/migrations/20260725000000_add_document_mindmap.sql` | The two columns |
| `lib/mindmap-types.ts` | `ConceptNode`, `DocMindmap`, validation, heading fallback |
| `lib/mindmap-hash.ts` | Server-only hashing and the staleness test |
| `lib/mindmap-ai.ts` | Extraction via OpenAI structured output |
| `lib/mindmap-store.ts` | Generate-and-persist, shared by all three writers |
| `lib/mindmap-graph.ts` | The flat shape the canvas draws |
| `lib/global-mindmap.ts` | Cross-document merge |
| `lib/load-docs.ts` | One loader that parses the jsonb and decides staleness |
| `app/api/mindmap/route.ts` | Rebuild / backfill one map |
| `app/vault/[docId]/mindmap/page.tsx` | Full-screen document mindmap |
| `app/vault/mindmap/page.tsx` | Full-screen global mindmap |
| `components/vault/mindmap-canvas.tsx` | Shared radial renderer |
| `components/vault/document-mindmap.tsx` | Document view |
| `components/vault/global-mindmap.tsx` | Global view |
| `lib/mindmap-types.test.ts`, `lib/global-mindmap.test.ts` | 48 unit tests |
| `e2e/mindmap-views.spec.ts` | 8 end-to-end tests |

Changed: ingest and regenerate both build the map inline (best-effort, so a
failed extraction never fails the note); the right-panel Mindmap tab reads the
stored map with a rebuild button; `Doc` carries `mindmap` + `mindmapStale`; the
ribbon gained a Global mindmap action; `MINDMAP_COLORS` added to `lib/theme.ts`.

### Decisions made during the build, beyond the plan

- **Depth is structural, not recursive.** The extraction JSON schema nests four
  explicit levels instead of using `$ref`, so the model *cannot* return a fifth.
  Caps are re-enforced in `toDocMindmap` anyway — an overshoot should shrink the
  map, not fail the ingest.
- **The concept map and the vault graph share a vocabulary.** Existing
  `[[wikilinks]]` are fed to the extractor as preferred concept names, and a
  concept whose name matches another note's title resolves to that note in the
  global view rather than becoming a duplicate node.
- **Staleness is server-side.** Hashing needs `node:crypto`, so pages decide it
  and hand the client a boolean. A note goes stale as soon as an edit saves,
  which is correct: the map really is describing older text.
- **Pills, not dots.** The vault graph hides labels until you zoom in; a mindmap
  is useless under that rule, so the canvas draws labelled rounded rects sized
  by depth.

### Verified

- `npx tsc --noEmit` clean.
- `npx vitest run` — 88 tests pass (48 new).
- `npx playwright test` — 25 tests pass, whole suite.
- One live `extractMindmap` call against the real API on a heading-less prose
  document returned a four-theme, two-level map with summaries. That is the
  exact case that used to produce an empty mindmap.

### Fixed along the way (pre-existing, not part of this plan)

These blocked the e2e suite from running at all, so they had to be fixed to
verify anything:

- `lib/wallet.ts` imported `@creit.tech/stellar-wallets-kit` at module scope. The
  kit reads `localStorage` while evaluating, so `/login` threw
  `localstorage?.getItem is not a function` during SSR and the dev server never
  became ready. Now lazily imported inside each function; `onWalletState` became
  async as a result (it has no callers).
- `e2e/auth.setup.ts` seeded the session into `localStorage`, but auth is
  cookie-based via `@supabase/ssr`, so `/vault` always redirected to `/login`. It
  now drives a real `createServerClient` against an in-memory jar and copies the
  cookies it writes into the browser context.
- `e2e/helpers.ts` hardcoded the pre-wallet user id, so seeded notes were owned
  by a user the browser was not signed in as and RLS hid all of them. The id is
  now resolved from the e2e wallet address.
- `e2e/vault-shell.spec.ts` asserted an email address and a "Sign out" button;
  the wallet rewrite had replaced both with a shortened public key and
  "Disconnect".

### Left undone

- `components/vault/graph-panel.tsx:56` and `hooks/use-mobile.ts:14` still fail
  `npx eslint .` with `react-hooks` errors. Both predate this work and neither
  was touched; fixing them is a separate change.
- Clicking any node in the document mindmap opens the note. The plan floated
  scrolling the editor to the matching section, which needs a heading-to-offset
  map the concept tree does not carry.

## Follow-up: layout and direct manipulation

Reported after the first version shipped: nodes on the global mindmap sat on top
of each other, and they could not be moved around the way Obsidian allows.

Both were real, and the second had a cause worth recording.

### Nothing overlaps any more

`lib/mindmap-layout.ts` is new: rectangular separation, since d3's own collision
force is circular and a circle large enough to hold "Landlord Responsibilities"
leaves a crater around it. Overlapping pairs are pushed apart along whichever
axis needs the least movement, correcting velocity as well as position so a link
spring cannot simply undo it on the next tick. It runs every tick during the
simulation, and again to a fixed point when the engine stops, since nothing will
integrate away a residual overlap once ticking has ceased.

Two things surfaced while testing it:

- The pass never reported convergence. A pair pushed to exactly `PILL_GAP` apart
  lands a hair inside the threshold next time it is compared, so the loop spent
  every pass on corrections far below a pixel. Fixed with an epsilon.
- The fixed-point loop now exits on the guarantee that matters — nothing
  *visibly* overlapping — rather than on every pair having its full gap, which
  costs many times more passes and looks identical.

### The forces were never being applied

Charge strength, link distance, and the new gravity force were all configured
against `graphRef.current`, and that ref was empty every time. Two separate
causes, one on top of the other:

1. `next/dynamic` does not forward a `ref` to the loaded component — it wraps it
   in `React.lazy`, and the ref never attaches. React 19 passing `ref` as an
   ordinary prop is not enough to save it.
2. Even once the ref was bridged, the dynamic import suspends, so the graph
   mounts a tick *after* its parent. Any effect the parent runs at its own mount
   still sees an empty ref, and nothing re-runs it later.

`components/vault/force-graph-2d.tsx` now sits on the browser side of that
boundary: it takes the ref as a plain prop, attaches it as a real `ref`, and
fires `onReady` once the instance genuinely exists. This was silent — the map
rendered fine, it just quietly ignored every force setting. Worth remembering
for anything else loaded through `next/dynamic`.

With the forces actually live, the vault-wide map also needed a gravity force:
notes that share no concept are disconnected components, so repulsion pushed
them apart with nothing to pull them back and the map degenerated into two
clusters in opposite corners with the content shrunk to fit.

### Moving nodes

- The global map dropped `dagMode: radialout`. It is a forest, not one tree, and
  the radial force both stacked the roots and fought anything the user moved.
  The document map keeps the radial layout, which reads well for a single tree.
- Dragging now pins: force-graph's default hands the node straight back to the
  simulation, which reads as the drag having been ignored. Right-click releases
  one node; **Reset layout** in the corner releases all of them.
- Verified end to end: dragging a node by (−200, +160) leaves it within a pixel
  or two of there after five seconds of further settling.

### Verified

- `npx vitest run` — 105 tests pass (17 new, covering separation, pinning,
  convergence, and the degenerate-pile bail-out).
- `npx playwright test` — 26 tests pass, including a new one that locates a real
  pill by its fill colour, drags it, and checks it stayed.
- Screenshots of both views inspected directly: no overlaps, labels legible, no
  empty void.

## Changelog

- 2026-07-25 — Plan written. Both open decisions resolved (full routes + panel
  tab; inline extraction).
- 2026-07-25 — Shipped. All eight steps landed and verified; four pre-existing
  e2e blockers fixed to get there.
- 2026-07-25 — Layout follow-up: rectangular collision, gravity for disconnected
  clusters, free layout for the global map, and drag-to-pin. Fixed the
  `next/dynamic` ref bridge that had been silently discarding every force
  setting.
