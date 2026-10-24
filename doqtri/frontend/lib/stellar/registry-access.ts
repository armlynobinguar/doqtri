/**
 * The database side of the relay's registry checks (server-only): who may
 * write which note or workspace, read through the service role at the moment
 * of each request. See authorizeRegistryWrite() in relay-validation.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { StrKey } from "@stellar/stellar-sdk";
import type { RegistryAccess } from "@/lib/stellar/relay-validation";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import type { WorkspaceRole } from "@/lib/workspace-roles";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registryAccess(admin: SupabaseClient): RegistryAccess {
  async function memberRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const { data, error } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(`workspace_members lookup failed: ${error.message}`);
    return (data?.role as WorkspaceRole | undefined) ?? null;
  }

  /** The account a passkey wallet (C…, per network) or a Freighter account (G…) belongs to. */
  async function userIdForAddress(address: string): Promise<string | null> {
    const query = StrKey.isValidContract(address)
      ? admin.from("smart_wallets").select("user_id").eq("network", NETWORK).eq("address", address)
      : StrKey.isValidEd25519PublicKey(address)
        ? admin.from("wallet_accounts").select("user_id").eq("address", address)
        : null;
    if (!query) return null;
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error(`wallet lookup failed: ${error.message}`);
    return (data?.user_id as string | undefined) ?? null;
  }

  return {
    async documentWorkspace(docId) {
      if (!UUID.test(docId)) return null;
      const { data, error } = await admin.from("documents").select("workspace_id").eq("id", docId).maybeSingle();
      if (error) throw new Error(`documents lookup failed: ${error.message}`);
      return (data?.workspace_id as string | undefined) ?? null;
    },
    memberRole,
    async addressRole(workspaceId, address) {
      const userId = await userIdForAddress(address);
      return userId ? memberRole(workspaceId, userId) : null;
    },
  };
}
