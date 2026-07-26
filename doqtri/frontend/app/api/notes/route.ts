import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import { uniqueTitle } from "@/lib/title";

/**
 * Create a blank Obsidian-style note. Headings become the mindmap live;
 * [[wikilinks]] feed the graph. No upload / AI required.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let requestedTitle = "Untitled";
  try {
    const body = (await request.json()) as { title?: unknown };
    if (typeof body.title === "string" && body.title.trim()) {
      requestedTitle = body.title.trim().slice(0, 120);
    }
  } catch {
    // empty body is fine — default Untitled
  }

  const admin = createSupabaseAdminClient();
  const { data: existing, error: titlesError } = await admin
    .from("documents")
    .select("title")
    .eq("user_id", user.id);

  if (titlesError) {
    return NextResponse.json({ error: titlesError.message }, { status: 500 });
  }

  const title = uniqueTitle(
    requestedTitle,
    (existing ?? []).map((row: { title: string }) => row.title),
  );

  const markdown = [
    `# ${title}`,
    "",
    "## Overview",
    "",
    "Write like Obsidian. Headings become the mindmap. Link ideas with [[wikilinks]].",
    "",
    "## Next",
    "",
  ].join("\n");

  const { data: inserted, error: insertError } = await admin
    .from("documents")
    .insert({ user_id: user.id, title, markdown })
    .select("id")
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ id: inserted.id, title });
}
