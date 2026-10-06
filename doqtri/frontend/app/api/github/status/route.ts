import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fetchGitHubItem } from "@/lib/github/fetch";
import { suggestStatus } from "@/lib/github/status";

/** Links checked per request; a note has far fewer headings than this. */
const MAX_LINKS = 50;
/** GitHub requests in flight at once. */
const CONCURRENCY = 5;

/**
 * For each GitHub link on one note, what the issue or PR says now and which
 * node status that suggests. Reads only; the owner signs any change in the
 * browser, because the contract requires the owner's signature.
 *
 * Uses the session client, not the service role: RLS limits the rows to the
 * caller's own links, so a docId that is not theirs simply returns nothing.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let docId: string;
  try {
    const body = (await request.json()) as { docId?: unknown };
    if (typeof body.docId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.docId)) {
      return NextResponse.json({ error: "Missing document id" }, { status: 400 });
    }
    docId = body.docId;
  } catch {
    return NextResponse.json({ error: "Malformed request body" }, { status: 400 });
  }

  const { data: links, error } = await supabase
    .from("node_links")
    .select("id, node_id, node_label, repo, number")
    .eq("document_id", docId)
    .order("created_at")
    .limit(MAX_LINKS);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  type Row = { id: string; node_id: string; node_label: string; repo: string; number: number };
  const rows = (links ?? []) as Row[];
  const results = new Array(rows.length);
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const fetched = await Promise.all(batch.map((r) => fetchGitHubItem({ repo: r.repo, number: r.number })));
    fetched.forEach((f, j) => {
      const r = batch[j];
      results[i + j] = {
        linkId: r.id,
        nodeId: r.node_id,
        nodeLabel: r.node_label,
        repo: r.repo,
        number: r.number,
        ...(f.ok
          ? { item: f.item, suggestion: suggestStatus(r.repo, f.item) }
          : { error: f.message }),
      };
    });
  }

  return NextResponse.json({ links: results }, { headers: { "Cache-Control": "no-store" } });
}
