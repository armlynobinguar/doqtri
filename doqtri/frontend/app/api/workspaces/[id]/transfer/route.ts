import { after } from "next/server";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { CONTRACT_ID, REGISTRY_EDITORS } from "@/lib/stellar/config";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { RelayRejection } from "@/lib/stellar/relay-validation";
import { registryAccess } from "@/lib/stellar/registry-access";
import { readChainWorkspace } from "@/lib/stellar/server-signer";
import { simulateWithinCap, submitAndConfirm } from "@/lib/stellar/channels";
import { runChainJobs } from "@/lib/stellar/chain-jobs";
import { acceptTransfer, type OpenTransfer } from "@/lib/workspace-transfer";

export const runtime = "nodejs";
export const maxDuration = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(error: string, status: number) {
  return Response.json({ ok: false, error }, { status });
}

/**
 * The new owner accepts a workspace transfer (D-29), sending their wallet's
 * signed approval of `transfer_workspace` when the workspace is on-chain.
 * The chain moves first, through Channels with both owners' signatures; the
 * database only once a ledger has it (acceptTransfer, workspace-transfer.ts).
 *
 * Responds `{ ok, txHash, followUp }`, where `followUp` is the `add_admin`
 * the new owner signs next so the former owner, kept as an admin in the
 * database, is an admin on-chain too (D-35).
 */
export async function POST(request: Request, context: RouteContext<"/api/workspaces/[id]/transfer">) {
  const { id } = await context.params;
  if (!UUID.test(id)) return fail("That isn't a workspace.", 404);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Sign in to continue.", 401);

  let body: { approval?: unknown } = {};
  try {
    body = ((await request.json()) ?? {}) as { approval?: unknown };
  } catch {
    // No body: accepting without a signature, which is fine off-chain.
  }

  // Service role: user.id comes from the verified session above, and
  // acceptTransfer checks it is the transfer's new owner.
  const admin = createSupabaseAdminClient();
  const { data: transfer, error } = await admin
    .from("workspace_transfers")
    .select("workspace_id, from_user, to_user, owner_address, new_owner_address, owner_approval")
    .eq("workspace_id", id)
    .maybeSingle();
  if (error) {
    console.error(`[workspaces/transfer] lookup failed: ${error.message}`);
    return fail("The transfer couldn't be loaded. Try again.", 500);
  }

  const access = registryAccess(admin);
  try {
    const result = await acceptTransfer((transfer as OpenTransfer | null) ?? null, user.id, body.approval, {
      editors: REGISTRY_EDITORS,
      registry: CONTRACT_ID,
      access,
      readChainOwner: async (workspaceId) => (await readChainWorkspace(workspaceId))?.owner ?? null,
      async addressOf(userId) {
        const { data, error: walletError } = await admin.rpc("account_chain_address", { p_user_id: userId, p_network: NETWORK });
        if (walletError) throw new Error(`wallet lookup failed: ${walletError.message}`);
        return (data as string | null) ?? null;
      },
      async submit(func, auth) {
        await simulateWithinCap(func, auth);
        return (await submitAndConfirm(func, auth)).hash;
      },
      async acceptInDatabase(workspaceId, userId) {
        const { data, error: acceptError } = await admin.rpc("accept_workspace_transfer", {
          p_workspace_id: workspaceId,
          p_user_id: userId,
        });
        if (acceptError) {
          // On-chain it may already be done; accepting again finishes this step.
          console.error(`[workspaces/transfer] database step failed for ${workspaceId}: ${acceptError.message}`);
          throw new RelayRejection(acceptError.message, 409);
        }
        return data as string;
      },
    });
    after(() => runChainJobs(admin, { workspaceId: id }).catch((e) => console.error("[workspaces/transfer] chain jobs", e)));
    return Response.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof RelayRejection) return fail(e.message, e.status);
    console.error("[workspaces/transfer] unexpected error", e);
    return fail("The transfer couldn't be completed. Try again.", 500);
  }
}
