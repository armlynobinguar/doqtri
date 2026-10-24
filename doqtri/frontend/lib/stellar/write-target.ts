import { toast } from "sonner";
import { REGISTRY_EDITORS } from "@/lib/stellar/config";
import type { WriteReceipt, WriteTarget } from "@/lib/stellar/contract-client";
import { DoqtriError } from "@/lib/stellar/errors";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * The workspace a note's on-chain writes go to (WP-1.4), for
 * DoqtriRegistry's write calls. Read at the moment of the write rather than
 * when the panel opens, so a write never goes out on a stale workspace.
 *
 * Null while REGISTRY_EDITORS is off: every write is then owner-only and
 * needs no lookup. While it is on, a failed lookup throws, since guessing
 * would send a team note's write to the owner-only calls, which its members
 * cannot sign.
 */
export async function loadWriteTarget(docId: string): Promise<WriteTarget | null> {
  if (!REGISTRY_EDITORS) return null;
  const { data, error } = await createSupabaseBrowserClient()
    .from("documents")
    .select("workspace_id, workspaces(is_personal)")
    .eq("id", docId)
    .maybeSingle();
  const embedded = data?.workspaces as { is_personal: boolean } | { is_personal: boolean }[] | null | undefined;
  const workspace = Array.isArray(embedded) ? embedded[0] : embedded;
  if (error || !data?.workspace_id || !workspace) {
    throw new DoqtriError("NO_WORKSPACE", "Couldn't load this note's workspace. Try again.");
  }
  return { workspaceId: data.workspace_id as string, personal: Boolean(workspace.is_personal) };
}

/**
 * Tells the signer when a team note's write landed but the note is not in
 * its workspace on-chain yet, so the other editors can't write it. The next
 * write by its on-chain owner retries the assignment.
 */
export function reportWorkspaceAssignment(receipt: Pick<WriteReceipt, "workspace">): void {
  if (receipt.workspace?.status === "unassigned") {
    toast.warning(`Saved on-chain, but not shared with the workspace yet: ${receipt.workspace.reason}`);
  }
}
