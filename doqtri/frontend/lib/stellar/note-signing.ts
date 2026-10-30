/**
 * Who may sign a note's on-chain writes, for the UI: the same rules the relay
 * applies in authorizeRegistryWrite(), so nobody is shown a button the relay
 * would refuse (D-43). The relay stays the check that counts; this only hides
 * what would fail. Pure apart from the Supabase client it is handed.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { roleAtLeast, type WorkspaceRole } from "@/lib/workspace-roles";

/** The signed-in user as one note's workspace sees them. */
export type NoteSigner = {
  /** Their role in the note's workspace, or null when they are not a member. */
  role: WorkspaceRole | null;
  /** The note sits in a personal workspace (D-30). */
  personal: boolean;
  /** They created the note (documents.user_id). */
  isAuthor: boolean;
};

/** Why the user may not sign the note's writes. */
export type NoteSigningRefusal = "not-member" | "viewer" | "personal-owner-only" | "author-or-owner-only";

/**
 * Whether `signer` may sign the anchor, update and node-status writes the app
 * sends for a note (writeMode picks which calls), or why not. `editors` is
 * REGISTRY_EDITORS.
 *
 * - Viewers read and never sign (D-14).
 * - In a personal workspace only its owner signs, whatever role its other
 *   members hold (D-44, an exception to D-14).
 * - On a team note while REGISTRY_EDITORS is off, the owner-only calls are
 *   the only ones there are, and whoever signs first owns the note on-chain:
 *   only its author or the workspace's owner may (D-43). With it on, any
 *   editor signs through the `*_as` calls.
 */
export function noteSigningRefusal(signer: NoteSigner, editors: boolean): NoteSigningRefusal | null {
  if (!signer.role) return "not-member";
  if (!roleAtLeast(signer.role, "editor")) return "viewer";
  if (signer.personal) return signer.role === "owner" ? null : "personal-owner-only";
  if (!editors && !signer.isAuthor && signer.role !== "owner") return "author-or-owner-only";
  return null;
}

/** One line for the panel, in place of the buttons it hides. */
export const NOTE_SIGNING_NOTICE: Record<NoteSigningRefusal, string> = {
  "not-member": "You aren't a member of this note's workspace, so you can't sign changes to it.",
  viewer: "Viewers can read this note but not sign changes to it.",
  "personal-owner-only": "Only the owner of this personal workspace can anchor its notes.",
  "author-or-owner-only": "Only this note's author or its workspace owner can anchor it for now.",
};

/**
 * The signed-in user's standing on a note, read through their own session
 * (RLS lets a member read their workspace's rows). Null when it can't be
 * read: the panel then shows its buttons and the relay decides.
 */
export async function loadNoteSigner(supabase: SupabaseClient, docId: string): Promise<NoteSigner | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: doc, error } = await supabase
    .from("documents")
    .select("user_id, workspace_id, workspaces(is_personal)")
    .eq("id", docId)
    .maybeSingle();
  const embedded = doc?.workspaces as { is_personal: boolean } | { is_personal: boolean }[] | null | undefined;
  const workspace = Array.isArray(embedded) ? embedded[0] : embedded;
  if (error || !doc?.workspace_id || !workspace) return null;
  const { data: member, error: memberError } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", doc.workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (memberError) return null;
  return {
    role: (member?.role as WorkspaceRole | undefined) ?? null,
    personal: Boolean(workspace.is_personal),
    isAuthor: doc.user_id === user.id,
  };
}
