import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import { MAX_TITLE_LENGTH } from "@/lib/title";
import { insertWorkspaceDocument, personalWorkspaceId } from "@/lib/workspace-docs";

/**
 * Create an Obsidian-style note, blank or from a template body. Headings
 * become the mindmap live; [[wikilinks]] feed the graph. No upload / AI required.
 *
 * The note goes into the user's personal workspace, the only one the vault
 * shows until WP-1.7 adds a workspace switcher.
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
  let workspaceId: string;
  try {
    workspaceId = await personalWorkspaceId(admin, user.id);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  const created = await insertWorkspaceDocument(admin, {
    userId: user.id,
    workspaceId,
    title: requestedTitle,
    markdown: (title) =>
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
          ].join("\n"),
  });

  if ("error" in created) {
    return NextResponse.json({ error: created.error }, { status: 500 });
  }

  return NextResponse.json({ id: created.id, title: created.title });
}
