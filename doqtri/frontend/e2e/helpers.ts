import { createHash } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { hashMarkdown } from "@/lib/mindmap-hash";
import { toDocMindmap, type DocMindmap } from "@/lib/mindmap-types";

/**
 * The wallet the e2e session belongs to. Login is wallet-based, so the browser
 * signs in as the Supabase user derived from this address — and seeded notes
 * have to be owned by that same user or RLS hides them.
 *
 * Sign-in requires a real signature, so this is a keypair rather than a bare
 * address. It is derived from a public, test-only seed: it never holds funds
 * and exists only for this suite's Supabase project.
 */
export const E2E_KEYPAIR = Keypair.fromRawEd25519Seed(
  createHash("sha256").update("doqtri-e2e-wallet").digest(),
);
export const E2E_WALLET = E2E_KEYPAIR.publicKey();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const REST = `${SUPABASE_URL}/rest/v1/documents`;

function headers() {
  if (!SERVICE_ROLE) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY missing — e2e tests seed notes directly to avoid paying for an ingest call per test.",
    );
  }
  return {
    apikey: SERVICE_ROLE,
    Authorization: `Bearer ${SERVICE_ROLE}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

const userIds = new Map<string, string>();

/**
 * The Supabase user id behind a wallet address.
 *
 * Resolved from the address rather than hardcoded: the id is created by
 * /api/auth/wallet the first time that wallet signs in, so a fresh Supabase
 * project gets a different one and a literal here would silently seed notes
 * that no test can see.
 */
export async function userIdForWallet(address: string): Promise<string> {
  const cached = userIds.get(address);
  if (cached) return cached;

  // /api/auth/wallet writes wallet_accounts on sign-in; one row per address,
  // so this stays a point lookup however many accounts the project holds.
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/wallet_accounts?address=eq.${address}&select=user_id`,
    { headers: headers() },
  );
  if (!res.ok) {
    throw new Error(`could not read wallet_accounts: ${res.status} ${await res.text()}`);
  }
  const rows = (await res.json()) as { user_id: string }[];
  if (rows.length !== 1) {
    throw new Error(
      `no Supabase user for wallet ${address}. It is created when that wallet first signs in — run the full suite, not a single spec.`,
    );
  }

  userIds.set(address, rows[0].user_id);
  return rows[0].user_id;
}

/** The id of the user the default browser session belongs to. */
export function testUserId(): Promise<string> {
  return userIdForWallet(E2E_WALLET);
}

/**
 * A user's personal workspace. Every account gets one on signup
 * (ensure_personal_workspace), and it is where the app puts a user's notes
 * until they switch.
 */
export async function personalWorkspaceId(userId?: string): Promise<string> {
  const owner = userId ?? (await testUserId());
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/workspaces?created_by=eq.${owner}&is_personal=eq.true&select=id`,
    { headers: headers() },
  );
  const rows = (await res.json()) as { id: string }[];
  if (!res.ok || rows.length !== 1) {
    throw new Error(`no personal workspace for ${owner}: ${res.status} ${JSON.stringify(rows)}`);
  }
  return rows[0].id;
}

/**
 * Seeds a note straight into Postgres. Tests deliberately do not go through
 * /api/ingest: that costs a real OpenAI call per test and the ingest path is
 * covered separately.
 *
 * `mindmap` seeds the stored concept map too, hashed against this markdown so
 * the note reads as fresh. Without it the note has no map, which is the
 * fallback case — both are worth testing, so both are reachable from here.
 *
 * The note goes into the test user's personal workspace unless `into` names
 * another workspace and author: documents.workspace_id is required and has
 * no default (WP-1.2).
 */
export async function seedNote(
  title: string,
  markdown: string,
  mindmap?: DocMindmap,
  into?: { workspaceId: string; userId: string },
): Promise<string> {
  const userId = into?.userId ?? (await testUserId());
  const row: Record<string, unknown> = {
    user_id: userId,
    workspace_id: into?.workspaceId ?? (await personalWorkspaceId(userId)),
    title,
    markdown,
  };
  if (mindmap) {
    row.mindmap = mindmap;
    row.mindmap_hash = hashMarkdown(markdown);
  }

  const res = await fetch(REST, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`seedNote failed: ${res.status} ${await res.text()}`);
  const [created] = (await res.json()) as { id: string }[];
  return created.id;
}

/**
 * A stored concept map, built the same way the extraction path builds one, so
 * tests exercise the real shape rather than hand-written JSON that could drift
 * from what `toDocMindmap` produces.
 */
export function fakeMindmap(
  title: string,
  themes: { label: string; children?: string[] }[],
): DocMindmap {
  return toDocMindmap(title, {
    label: title,
    children: themes.map((theme) => ({
      label: theme.label,
      children: (theme.children ?? []).map((label) => ({ label })),
    })),
  });
}

export async function readNote(id: string): Promise<{ title: string; markdown: string }> {
  const res = await fetch(`${REST}?id=eq.${id}&select=title,markdown`, {
    headers: headers(),
  });
  const [row] = (await res.json()) as { title: string; markdown: string }[];
  return row;
}

export async function deleteNote(id: string): Promise<void> {
  // A note linked to a qdit project refuses deletion (D-68 trigger); the
  // link's cascade takes the note's qdit node_links with it.
  await fetch(`${SUPABASE_URL}/rest/v1/doc_project_links?document_id=eq.${id}`, {
    method: "DELETE",
    headers: headers(),
  });
  await fetch(`${REST}?id=eq.${id}`, { method: "DELETE", headers: headers() });
}

/**
 * A PostgREST call as the service role, for seeding and reading back rows
 * the specs cannot reach through the UI. Throws on a non-2xx answer.
 */
export async function serviceRest<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: init.method ?? "GET",
    headers: { ...headers(), ...(init.prefer ? { Prefer: init.prefer } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** Unique per run so parallel or repeated runs cannot collide on title. */
export function uniqueTitle(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}`;
}

/*
 * The note editor is CodeMirror with a live preview: the text on screen hides
 * markdown syntax except on the caret's line, so the document cannot be read
 * off the DOM. These helpers go through the editor view instead, which the
 * editor exposes on its root element for exactly this (see
 * components/vault/live-editor/markdown-editor.tsx).
 */

/** The editable surface of the note editor. */
export function noteEditor(page: Page): Locator {
  return page.getByTestId("note-editor").locator(".cm-content");
}

/**
 * The note's editor once it accepts typing. The editor is read-only until the
 * edit-lock status has loaded (WP-1.6); keys pressed before that are dropped,
 * so every spec that types waits for this first.
 */
export async function editableEditor(page: Page): Promise<Locator> {
  const content = noteEditor(page);
  await expect(content).toBeVisible();
  await expect(content).toHaveAttribute("contenteditable", "true");
  await expect(content).not.toHaveAttribute("aria-readonly", "true");
  return content;
}

type ViewHandle = {
  state: {
    doc: { toString(): string; length: number };
  };
  dispatch(spec: unknown): void;
  focus(): void;
  hasFocus: boolean;
};

/** The element the editor exposes its view on. */
function editorRoot(page: Page): Locator {
  return page.getByTestId("note-editor").locator(".cm-editor");
}

/** The note's markdown, exactly as the editor holds it. */
export function editorText(page: Page): Promise<string> {
  return editorRoot(page).evaluate(
    (el) => (el as unknown as { __doqtriEditor: ViewHandle }).__doqtriEditor.state.doc.toString(),
  );
}

/** Waits for the editor's markdown to match: the CodeMirror stand-in for toHaveValue. */
export async function expectEditorText(page: Page, expected: string | RegExp, timeout?: number) {
  const poll = expect.poll(() => editorText(page), { timeout });
  if (typeof expected === "string") await poll.toBe(expected);
  else await poll.toMatch(expected);
}

/**
 * Focuses the editor and puts the caret at `anchor` (or selects to `head`).
 * Negative positions count back from the end.
 */
export async function setEditorSelection(page: Page, anchor: number, head?: number) {
  await editorRoot(page).evaluate(
    (el, [a, h]) => {
      const view = (el as unknown as { __doqtriEditor: ViewHandle }).__doqtriEditor;
      const length = view.state.doc.length;
      const at = (pos: number) => (pos < 0 ? length + pos + 1 : pos);
      view.focus();
      view.dispatch({ selection: { anchor: at(a), head: at(h) }, scrollIntoView: true });
    },
    [anchor, head ?? anchor] as const,
  );
}

/** Focuses the editor with the caret just after the first occurrence of `text`. */
export async function placeCaretAfter(page: Page, text: string) {
  const at = (await editorText(page)).indexOf(text);
  if (at < 0) throw new Error(`"${text}" is not in the note`);
  await setEditorSelection(page, at + text.length);
}

/**
 * Replaces the whole note, as one paste: the stand-in for selecting all and
 * filling a textarea. Goes through the editor's input path, so it counts as
 * an edit — it takes the lock and is saved like typing.
 */
export async function replaceEditorText(page: Page, text: string) {
  await editableEditor(page);
  await editorRoot(page).evaluate(
    (el, t) => {
      const view = (el as unknown as { __doqtriEditor: ViewHandle }).__doqtriEditor;
      view.focus();
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: t },
        selection: { anchor: t.length },
        userEvent: "input.paste",
      });
    },
    text,
  );
}

/** Whether the note editor holds keyboard focus. */
export function editorHasFocus(page: Page): Promise<boolean> {
  return editorRoot(page).evaluate((el) => (el as unknown as { __doqtriEditor: ViewHandle }).__doqtriEditor.hasFocus);
}

/** The main selection, as document positions. */
export function editorSelection(page: Page): Promise<{ anchor: number; head: number }> {
  return editorRoot(page).evaluate((el) => {
    const view = (el as unknown as { __doqtriEditor: { state: { selection: { main: { anchor: number; head: number } } } } })
      .__doqtriEditor;
    const { anchor, head } = view.state.selection.main;
    return { anchor, head };
  });
}

/** The editor's rendered line holding `text` (as displayed, syntax hidden or not). */
export function editorLine(page: Page, text: string | RegExp): Locator {
  return noteEditor(page).locator(".cm-line").filter({ hasText: text });
}
