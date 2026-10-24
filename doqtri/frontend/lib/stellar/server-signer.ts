/**
 * Registry calls signed by one of the app's own server keys (server-only):
 * the revoke-only key (REVOKER_SECRET_KEY, D-16) and, when the product owner
 * provides it, the contract admin's (CONTRACT_ADMIN_SECRET, D-36).
 *
 * The key's account is the transaction source, so its signature on the
 * envelope also authorizes the call (`caller.require_auth()` on the source
 * account needs no separate auth entry), and it pays the fee. Nothing here
 * goes through Channels or the relay: these calls name no user's wallet.
 */
import { Address, BASE_FEE, Contract, Keypair, rpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { Client } from "@/lib/bindings/doqtri-registry";
import { CONTRACT_ID, IS_MAINNET, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import { parseChainWorkspace, type ChainWorkspace } from "@/lib/stellar/workspace-chain";

/** The registry's error codes a server call can meet, by number. */
const CONTRACT_ERROR = /Error\(Contract, #(\d+)\)/;

/** A call the network refused for a reason retrying will not fix by itself. */
export class ChainCallRefused extends Error {
  constructor(
    message: string,
    /** The registry's error code, when the contract refused it. */
    readonly code: number | null,
  ) {
    super(message);
    this.name = "ChainCallRefused";
  }
}

/** The keypair for a server secret env var, or null when it is unset. Throws on a malformed one. */
export function serverKeypair(name: "REVOKER_SECRET_KEY" | "CONTRACT_ADMIN_SECRET"): Keypair | null {
  const secret = process.env[name]?.trim();
  if (!secret) return null;
  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new Error(`${name} is not a Stellar secret key.`);
  }
}

/** How many one-second checks to wait for a ledger (~5s each) to include a call. */
const CONFIRM_ATTEMPTS = 30;

async function sourceAccount(server: rpc.Server, kp: Keypair) {
  try {
    return await server.getAccount(kp.publicKey());
  } catch (error) {
    // A fresh testnet key: Friendbot creates and funds it once.
    if (IS_MAINNET) throw error;
    await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`).catch(() => undefined);
    return server.getAccount(kp.publicKey());
  }
}

/**
 * Signs `fn(args)` on the registry as `kp`, submits it and waits until a
 * ledger includes it; returns the hash. A contract refusal (seen in
 * simulation) throws ChainCallRefused with its code; anything else (RPC
 * down, a stale sequence, a ledger that did not include it in time) throws
 * a plain Error, which callers treat as worth retrying.
 */
export async function submitRegistryCall(kp: Keypair, fn: string, args: xdr.ScVal[]): Promise<string> {
  const server = new rpc.Server(RPC_URL);
  const account = await sourceAccount(server, kp);
  const tx = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(CONTRACT_ID).call(fn, ...args))
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    const code = CONTRACT_ERROR.exec(simulation.error)?.[1];
    throw new ChainCallRefused(`${fn} would fail on-chain: ${simulation.error.slice(0, 200)}`, code ? Number(code) : null);
  }
  const prepared = rpc.assembleTransaction(tx, simulation).build();
  prepared.sign(kp);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
    const code = sent.errorResult?.result().switch().name ?? sent.status;
    throw new Error(`${fn} was not accepted by the network (${code}).`);
  }
  const result = await server.pollTransaction(sent.hash, { attempts: CONFIRM_ATTEMPTS });
  if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
  if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    throw new Error(`${fn} ${sent.hash} is not in a ledger yet.`);
  }
  throw new Error(`${fn} ${sent.hash} failed on-chain.`);
}

/** The workspace as the registry holds it, or null when it is not on-chain. Throws on transport errors. */
export async function readChainWorkspace(workspaceId: string): Promise<ChainWorkspace | null> {
  const client = new Client({ contractId: CONTRACT_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL });
  const tx = await client.get_workspace({ workspace_id: workspaceId });
  const result = tx.result as unknown as {
    isErr?: () => boolean;
    unwrap: () => unknown;
    unwrapErr: () => { message?: string } | undefined;
  };
  if (typeof result?.isErr === "function" && result.isErr()) {
    const simulated = String((tx as unknown as { simulation?: { error?: unknown } }).simulation?.error ?? "");
    const message = result.unwrapErr()?.message ?? "";
    // #7 WorkspaceNotFound: nothing on-chain to bring down or hand over.
    if (CONTRACT_ERROR.exec(simulated)?.[1] === "7" || message === "WorkspaceNotFound") return null;
    throw new Error(`get_workspace failed: ${(simulated || message).slice(0, 200)}`);
  }
  return parseChainWorkspace(typeof result?.unwrap === "function" ? result.unwrap() : result);
}

/** The ScVals of a membership call: (workspace_id, caller, subject). */
export function membershipArgs(workspaceId: string, caller: string, subject: string): xdr.ScVal[] {
  return [xdr.ScVal.scvString(workspaceId), Address.fromString(caller).toScVal(), Address.fromString(subject).toScVal()];
}
