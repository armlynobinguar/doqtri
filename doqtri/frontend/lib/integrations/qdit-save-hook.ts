import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { qditIntegrationEnabled } from "@/lib/integrations/qdit-config";
import { createQditClient, qditServerSetup } from "@/lib/integrations/qdit-client";
import { remapAfterSave, syncQditLinks } from "@/lib/integrations/qdit-linking";
import { registryVersion } from "@/lib/integrations/qdit-route-context";

/**
 * What a save does to the note's links (WP-2.5, R-03; server-only). Called
 * by the routes that save through save_document() (WP-1.6), after it
 * succeeded, so the edit lock and the version check have already passed.
 *
 * Off with the integration (NEXT_PUBLIC_QDIT_INTEGRATION unset): the live
 * app saves exactly as before, and GitHub links stay where they were made.
 *
 * The remap itself runs before the response, so the ship panel never reads
 * a link on a heading's old id; telling qdit runs after it (`after()`), as
 * the saver, so a slow qdit never slows a save. A saver with no qdit
 * connection leaves the links `pending` for someone who has one to Retry.
 * Nothing here can fail the save.
 */

/** The note as the save found it: lets the remap use structure, not only labels. */
export type NoteBeforeSave = { title: string; markdown: string; version: number } | null;

/** Read with the caller's session, before the save. Null when the integration is off. */
export async function noteBeforeSave(supabase: SupabaseClient, docId: string): Promise<NoteBeforeSave> {
  if (!qditIntegrationEnabled()) return null;
  try {
    const { data } = await supabase
      .from("documents")
      .select("title, markdown, version")
      .eq("id", docId)
      .maybeSingle();
    if (!data) return null;
    const version = Number(data.version);
    return Number.isSafeInteger(version)
      ? { title: String(data.title ?? ""), markdown: String(data.markdown ?? ""), version }
      : null;
  } catch {
    return null;
  }
}

export async function afterNoteSaved(params: {
  userId: string;
  docId: string;
  /** The version the save was based on, and the one it produced. */
  baseVersion: number;
  savedVersion: number;
  markdown: string;
  before: NoteBeforeSave;
  /** The note's title, when the caller already has it. */
  title?: string;
}): Promise<void> {
  if (!qditIntegrationEnabled() || params.savedVersion === params.baseVersion) return;
  const { userId, docId, savedVersion, markdown, before } = params;
  try {
    const admin = createSupabaseAdminClient();
    let title = params.title ?? before?.title;
    if (title === undefined) {
      const { data } = await admin.from("documents").select("title").eq("id", docId).maybeSingle();
      title = String(data?.title ?? "");
    }
    // The old text counts only if it is the very version this save replaced.
    const previousMarkdown = before && before.version === params.baseVersion ? before.markdown : null;
    const { qditPending } = await remapAfterSave(admin, {
      docId,
      version: savedVersion,
      title,
      markdown,
      previousMarkdown,
    });
    if (!qditPending) return;
    const setup = qditServerSetup();
    if (!setup) return;
    after(async () => {
      try {
        const client = createQditClient(userId, { config: setup.config, store: setup.store });
        const result = await syncQditLinks({ admin, client, docId, chainVersion: registryVersion });
        if (result.failed.length > 0) {
          console.warn(`[qdit-linking] ${result.failed.length} link(s) of ${docId} still pending after the save`);
        }
      } catch (error) {
        console.warn(`[qdit-linking] sync after save failed for ${docId}: ${(error as Error).message}`);
      }
    });
  } catch (error) {
    console.warn(`[qdit-linking] links not remapped for ${docId}: ${(error as Error).message}`);
  }
}
