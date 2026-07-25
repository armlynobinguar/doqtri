import { hashMarkdown } from "@/lib/mindmap-hash";
import { toDocMindmap, type DocMindmap } from "@/lib/mindmap-types";
import { walletEmail } from "@/lib/wallet-auth";

/**
 * The wallet the e2e session belongs to. Login is wallet-based, so the browser
 * signs in as the Supabase user derived from this address — and seeded notes
 * have to be owned by that same user or RLS hides them.
 */
export const E2E_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

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

let cachedUserId: string | undefined;

/**
 * The id of the user the browser session belongs to.
 *
 * Resolved from the wallet address rather than hardcoded: the id is created by
 * /api/auth/wallet the first time the setup project runs, so a fresh Supabase
 * project gets a different one and a literal here would silently seed notes
 * that no test can see.
 */
export async function testUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;

  const email = walletEmail(E2E_WALLET);
  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1000`,
    { headers: headers() },
  );
  if (!res.ok) {
    throw new Error(`could not list users: ${res.status} ${await res.text()}`);
  }

  const { users } = (await res.json()) as { users: { id: string; email?: string }[] };
  const user = users.find((candidate) => candidate.email?.toLowerCase() === email);
  if (!user) {
    throw new Error(
      `no Supabase user for the e2e wallet (${email}). The setup project creates it — run the full suite, not a single spec.`,
    );
  }

  cachedUserId = user.id;
  return user.id;
}

/**
 * Seeds a note straight into Postgres. Tests deliberately do not go through
 * /api/ingest: that costs a real OpenAI call per test and the ingest path is
 * covered separately.
 *
 * `mindmap` seeds the stored concept map too, hashed against this markdown so
 * the note reads as fresh. Without it the note has no map, which is the
 * fallback case — both are worth testing, so both are reachable from here.
 */
export async function seedNote(
  title: string,
  markdown: string,
  mindmap?: DocMindmap,
): Promise<string> {
  const row: Record<string, unknown> = {
    user_id: await testUserId(),
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
  await fetch(`${REST}?id=eq.${id}`, { method: "DELETE", headers: headers() });
}

/** Unique per run so parallel or repeated runs cannot collide on title. */
export function uniqueTitle(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}`;
}
