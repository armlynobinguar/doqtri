import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from "@/lib/supabase/server";
import { hasControlCharacters, MAX_TITLE_LENGTH, TITLE_ONE_LINE } from "@/lib/title";
import { insertWorkspaceDocument } from "@/lib/workspace-docs";
import { readActiveWorkspaceCookie, workspaceForCreate } from "@/lib/active-workspace";

/**
 * Create an Obsidian-style note, blank or from a template body. Headings
 * become the mindmap live; [[wikilinks]] feed the graph. No upload / AI required.
 *
 * The title is the row's `title` and nothing else (D-121): the text starts
 * with the body, not with a `# <title>` line.
 *
 * The note goes into the workspace the request names (the one the vault is
 * showing), else the active one, else the personal one; editors and above
 * only (WP-1.7, D-14). See workspaceForCreate().
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
  let requestedWorkspace: unknown;
  try {
    const body = (await request.json()) as { title?: unknown; body?: unknown; workspaceId?: unknown };
    requestedWorkspace = body.workspaceId;
    if (typeof body.title === "string" && body.title.trim()) {
      if (hasControlCharacters(body.title.trim())) {
        return NextResponse.json({ error: TITLE_ONE_LINE, code: "BAD_TITLE" }, { status: 400 });
      }
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
  const target = await workspaceForCreate(admin, user.id, {
    requested: requestedWorkspace,
    cookie: await readActiveWorkspaceCookie(user.id),
  });
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: target.status });
  const { workspaceId } = target;

  const created = await insertWorkspaceDocument(admin, {
    userId: user.id,
    workspaceId,
    title: requestedTitle,
    markdown:
      templateBody !== null
        ? templateBody
        : [
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
