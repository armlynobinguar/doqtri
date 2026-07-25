export const TEST_USER = {
  email: "alice.mindmap@gmail.com",
  password: "test-passw0rd-123",
  id: "1c206b4f-1fd5-46e5-bc92-8c5d19b7dcb4",
};

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

/**
 * Seeds a note straight into Postgres. Tests deliberately do not go through
 * /api/ingest: that costs a real OpenAI call per test and the ingest path is
 * covered separately.
 */
export async function seedNote(title: string, markdown: string): Promise<string> {
  const res = await fetch(REST, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ user_id: TEST_USER.id, title, markdown }),
  });
  if (!res.ok) throw new Error(`seedNote failed: ${res.status} ${await res.text()}`);
  const [row] = (await res.json()) as { id: string }[];
  return row.id;
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
