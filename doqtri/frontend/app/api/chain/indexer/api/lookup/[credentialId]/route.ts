import { Contract, rpc } from "@stellar/stellar-sdk";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { HORIZON_URL, RPC_URL } from "@/lib/stellar/config";
import { NETWORK, SMART_ACCOUNT_WASM_HASH } from "@/lib/stellar/smart-wallet-config";

/**
 * A wallet indexer for smart-account-kit, answering from Supabase instead of
 * Mercury (progress/002). The kit asks it which wallet a passkey controls and
 * how that wallet was born, then verifies the claimed creation transaction
 * against the ledger itself (RPC, then Horizon) before it will sign. So this
 * is a hint the kit checks, not something it trusts; it only saves us
 * running an event indexer.
 *
 * Path and response follow the kit's schema-2 wire format:
 * `${indexerUrl}/api/lookup/<credential id, lowercase hex>`.
 * Signed-in only, and only the caller's own wallet is ever returned.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ credentialId: string }> }) {
  const { credentialId: hex } = await params;
  if (!/^[0-9a-f]{2,512}$/.test(hex) || hex.length % 2 !== 0) {
    return Response.json({ error: "Invalid credential id" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  const server = new rpc.Server(RPC_URL);
  const { sequence: latestLedger } = await server.getLatestLedger();
  const empty = { credentialId: hex, contracts: [], count: 0, schema: 2, complete: true, indexed_through_ledger: latestLedger };

  // RLS: the caller's own passkeys and wallet only.
  const credentialId = Buffer.from(hex, "hex").toString("base64url");
  const { data: passkey } = await supabase
    .from("wallet_passkeys")
    .select("credential_id")
    .eq("network", NETWORK)
    .eq("credential_id", credentialId)
    .maybeSingle();
  if (!passkey) return Response.json(empty);
  const { data: wallet } = await supabase
    .from("smart_wallets")
    .select("address, created_tx")
    .eq("network", NETWORK)
    .maybeSingle();
  if (!wallet) return Response.json(empty);

  const [creationLedger, currentWasmHash] = await Promise.all([
    creationLedgerOf(wallet.created_tx),
    currentWasmHashOf(server, wallet.address),
  ]);
  if (!creationLedger || !currentWasmHash) {
    return Response.json({ error: "Wallet history is unavailable right now." }, { status: 503 });
  }

  return Response.json({
    ...empty,
    count: 1,
    contracts: [
      {
        contract_id: wallet.address,
        context_rule_count: 1,
        external_signer_count: 1,
        delegated_signer_count: 0,
        native_signer_count: 0,
        first_seen_ledger: creationLedger,
        last_seen_ledger: latestLedger,
        context_rule_ids: [0],
        birth_wasm_hash: SMART_ACCOUNT_WASM_HASH,
        creation_transaction_hash: wallet.created_tx,
        creation_ledger: creationLedger,
        current_wasm_hash: currentWasmHash,
        // The relay only records wallets deployed at the address the shared
        // deployer derives from this credential.
        derived_address: true,
        collision: false,
        incomplete: false,
      },
    ],
  });
}

/** Horizon keeps every transaction, unlike RPC's ~7-day window. */
async function creationLedgerOf(txHash: string): Promise<number | null> {
  const res = await fetch(`${HORIZON_URL}/transactions/${txHash}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { ledger?: number; successful?: boolean };
  return body.successful && Number.isSafeInteger(body.ledger) ? (body.ledger as number) : null;
}

async function currentWasmHashOf(server: rpc.Server, address: string): Promise<string | null> {
  const { entries } = await server.getLedgerEntries(new Contract(address).getFootprint());
  const executable = entries[0]?.val.contractData().val().instance().executable();
  return executable?.switch().name === "contractExecutableWasm" ? executable.wasmHash().toString("hex") : null;
}
