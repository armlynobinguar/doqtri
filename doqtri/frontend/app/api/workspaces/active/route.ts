import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listMyWorkspaces } from "@/lib/active-workspace";
import {
  ACTIVE_WORKSPACE_COOKIE,
  ACTIVE_WORKSPACE_MAX_AGE_S,
  encodeActiveWorkspace,
  isWorkspaceId,
  vaultReturnPath,
  type WorkspaceChoice,
} from "@/lib/workspace-scope";

/**
 * Switches the vault's active workspace (WP-1.7). Only to a workspace the
 * caller is a member of, checked through their own session (RLS shows a
 * member their memberships); the pages check it again on every load, so the
 * cookie never grants anything.
 *
 * POST { workspaceId } is the switcher's; it answers with the workspace.
 * GET ?ws=<id>&next=<vault path> is for links into a note in another of the
 * caller's workspaces: it switches and sends them on. A GET can be triggered
 * by another site, but all it can do is move the caller between workspaces
 * they already belong to, and `next` is held to vault paths.
 */

async function memberWorkspace(workspaceId: string): Promise<
  { ok: true; userId: string; workspace: WorkspaceChoice } | { ok: false; status: 401 | 404 | 500; error: string }
> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "Not signed in" };

  try {
    const workspace = (await listMyWorkspaces(supabase, user.id)).find((w) => w.id === workspaceId);
    if (!workspace) return { ok: false, status: 404, error: "That workspace isn't one of yours." };
    return { ok: true, userId: user.id, workspace };
  } catch (error) {
    return { ok: false, status: 500, error: (error as Error).message };
  }
}

function remember(response: NextResponse, request: NextRequest, userId: string, workspaceId: string) {
  response.cookies.set(ACTIVE_WORKSPACE_COOKIE, encodeActiveWorkspace(userId, workspaceId), {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: ACTIVE_WORKSPACE_MAX_AGE_S,
  });
}

export async function POST(request: NextRequest) {
  let workspaceId: unknown;
  try {
    workspaceId = ((await request.json()) as { workspaceId?: unknown }).workspaceId;
  } catch {
    workspaceId = undefined;
  }
  if (!isWorkspaceId(workspaceId)) {
    return NextResponse.json({ error: "That workspace isn't one of yours." }, { status: 404 });
  }

  const found = await memberWorkspace(workspaceId);
  if (!found.ok) return NextResponse.json({ error: found.error }, { status: found.status });

  const response = NextResponse.json({ workspace: found.workspace });
  remember(response, request, found.userId, workspaceId);
  return response;
}

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get("ws");
  const next = vaultReturnPath(request.nextUrl.searchParams.get("next"));

  const found = isWorkspaceId(workspaceId) ? await memberWorkspace(workspaceId) : null;
  if (found?.ok === false && found.status === 401) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  // Not a member: back to the vault, not to `next`, which would only bounce
  // here again.
  const response = NextResponse.redirect(new URL(found?.ok ? next : "/vault", request.url));
  if (found?.ok) remember(response, request, found.userId, found.workspace.id);
  return response;
}
