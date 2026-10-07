import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import { MAX_TITLE_LENGTH, uniqueTitle } from "@/lib/title";

/**
 * Create an Obsidian-style note, blank or from a template body. Headings
 * become the mindmap live; [[wikilinks]] feed the graph. No upload / AI required.
 */
/** Upper bound on a template body, in characters. */
const MAX_TEMPLATE_BODY = 50_000;

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let requestedTitle = "Untitled";
  let templateBody: string | null = null;
  try {
    const body = (await request.json()) as { title?: unknown; body?: unknown };
    if (typeof body.title === "string" && body.title.trim()) {
      requestedTitle = body.title.trim().slice(0, MAX_TITLE_LENGTH);
    }
    if (typeof body.body === "string" && body.body.trim()) {
      if (body.body.length > MAX_TEMPLATE_BODY) {
        return NextResponse.json({ error: "Template is too long" }, { status: 413 });
      }
      templateBody = body.body;
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

  const markdown =
    templateBody !== null
      ? `# ${title}\n\n${templateBody}`
      : [
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
