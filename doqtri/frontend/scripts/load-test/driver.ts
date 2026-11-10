/**
 * The network half of the paid-write load test (DOQ-2, WP-4.1): test users,
 * their passkey wallets, and the requests a browser would send. Kept thin;
 * the decisions live in report.ts and paid-write.ts.
 *
 * Every request goes through the deployment's own routes as an email user's
 * browser would: notes through /api/notes, the wallet deploy and each paid
 * write through /api/chain/relay, a missed top-up through /api/chain/topup.
 * Two things differ from a person at a browser, because neither can be done
 * headlessly:
 * - Test users are created confirmed with the target's service-role key and
 *   signed in with a magic-link token it issues (no inbox, no captcha). The
 *   relay sees an ordinary email account's session cookie.
 * - The passkey is a software P-256 key (soft-passkey.ts).
 */
import { createHash } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { rpc, type xdr } from "@stellar/stellar-sdk";
import { MemoryStorage, SmartAccountKit } from "smart-account-kit";
import { Buffer as BindingsBuffer, Client as RegistryClient } from "@/lib/bindings/doqtri-registry";
import { CONTRACT_ID, HORIZON_URL, NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import {
  DOQTRI_RELAYER,
  FEE_FORWARDER,
  MAX_USER_FEE_STROOPS,
  NATIVE_XLM,
  SMART_ACCOUNT_WASM_HASH,
  THRESHOLD_POLICY,
  WEBAUTHN_VERIFIER,
} from "@/lib/stellar/smart-wallet-config";
import { xlmBalanceStroops } from "@/lib/stellar/wallet-balance";
import { callsIn, draftFunc, forwardDraft, relayBody, walletEntryOf } from "./paid-write";
import { softWebAuthn, type SoftPasskey } from "./soft-passkey";

/** The deployment under test. */
export type Target = {
  baseUrl: string;
  /** Extra headers on every request (a Vercel protection bypass, say). */
  headers: Record<string, string>;
};

export type Session = { email: string; userId: string; cookie: string };

/** What the state file keeps for one test wallet between runs. */
export type WalletRecord = {
  address: string;
  createdTx: string;
  creationLedger: number;
  birthWasmHash: string;
  birthConstructorArgsHash: string;
};

export type RelayBody = { func: string; auth: string[] };

type Kit = InstanceType<typeof SmartAccountKit>;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set (use the target deployment's value).`);
  return value;
}

/** Service-role client for the target's Supabase: only creates and signs in test users. */
export function adminClient(): SupabaseClient {
  return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Creates the email user, already confirmed; returns its id. An existing user is reused. */
export async function ensureTestUser(admin: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (data.user) return data.user.id;
  if (!/already|exists|registered/i.test(error?.message ?? "")) throw new Error(`creating ${email}: ${error?.message}`);
  // Re-sign-in finds it: generateLink answers with the existing user.
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (!link.data.user) throw new Error(`finding ${email}: ${link.error?.message}`);
  return link.data.user.id;
}

/**
 * A browser session for `email`: a magic-link token from the admin API,
 * verified the way /auth/confirm does, stored in the same cookies
 * @supabase/ssr writes for the app.
 */
export async function signIn(admin: SupabaseClient, email: string): Promise<Session> {
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.data.properties?.hashed_token;
  if (!tokenHash || !link.data.user) throw new Error(`magic link for ${email}: ${link.error?.message}`);

  const jar = new Map<string, string>();
  const supabase = createServerClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => (value ? jar.set(name, value) : jar.delete(name))),
    },
  });
  const { data, error } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (error || !data.session) throw new Error(`signing in ${email}: ${error?.message ?? "no session"}`);
  await supabase.auth.setSession(data.session);
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  return { email, userId: link.data.user.id, cookie };
}

/** A JSON request to the deployment as `session`. Never throws on an HTTP error. */
export async function api(
  target: Target,
  session: Session,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${target.baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...target.headers, "Content-Type": "application/json", Cookie: session.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** The kit as lib/passkey-wallet.ts configures it, with the software passkey and no browser. */
export function walletKit(passkey: SoftPasskey, origin: string): { kit: Kit; storage: InstanceType<typeof MemoryStorage> } {
  const storage = new MemoryStorage();
  const kit = new SmartAccountKit({
    storage,
    webAuthn: softWebAuthn(passkey, origin),
    rpId: new URL(origin).hostname,
    allowedOrigins: [origin],
    rpName: "Doqtri",
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    accountWasmHash: SMART_ACCOUNT_WASM_HASH,
    webauthnVerifierAddress: WEBAUTHN_VERIFIER,
    defaultPolicies: [{ address: THRESHOLD_POLICY, type: "threshold" as const, installParams: { threshold: 1 } }],
    // The wallet's birth comes from the state file, not an indexer.
    indexerUrl: false,
    horizonUrl: HORIZON_URL,
  });
  return { kit, storage };
}

/**
 * Builds the wallet deploy with the kit (createPasskeyWallet's call, without
 * auto-submit) and returns the relay payload and what the state file keeps
 * of the wallet's birth.
 */
export async function buildWalletDeploy(
  kit: Kit,
  storage: InstanceType<typeof MemoryStorage>,
  passkey: SoftPasskey,
): Promise<{ payload: RelayBody; address: string; birthWasmHash: string; birthConstructorArgsHash: string }> {
  const created = await kit.createWallet("Doqtri", "loadtest", { autoSubmit: false, authenticatorSelection: { residentKey: "required" } });
  if (!created.relayerPayload) throw new Error("The kit built a deploy the relay cannot take (no {func, auth}).");
  const stored = await storage.get(passkey.credentialId);
  if (!stored?.birthWasmHash || !stored.birthConstructorArgsHash) throw new Error("The kit did not record the wallet's birth.");
  return {
    payload: created.relayerPayload,
    address: created.contractId,
    birthWasmHash: stored.birthWasmHash,
    birthConstructorArgsHash: stored.birthConstructorArgsHash,
  };
}

/** The ledger a confirmed transaction landed in. */
export async function ledgerOf(hash: string): Promise<number> {
  const result = await new rpc.Server(RPC_URL).pollTransaction(hash, { attempts: 20 });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`${hash} ended ${result.status}`);
  return result.ledger;
}

/** Deploys the user's wallet through the relay, as createPasskeyWallet does. */
export async function deployTestWallet(target: Target, session: Session, passkey: SoftPasskey): Promise<WalletRecord> {
  const { kit, storage } = walletKit(passkey, target.baseUrl);
  const built = await buildWalletDeploy(kit, storage, passkey);
  const res = await api(target, session, "/api/chain/relay", built.payload);
  const hash = (res.json.data as { hash?: string } | undefined)?.hash;
  if (res.status !== 200 || !hash) throw new Error(`wallet deploy: ${res.status} ${String(res.json.error ?? "")}`);
  return {
    address: built.address,
    createdTx: hash,
    creationLedger: await ledgerOf(hash),
    birthWasmHash: built.birthWasmHash,
    birthConstructorArgsHash: built.birthConstructorArgsHash,
  };
}

/**
 * Connects a fresh kit to a recorded wallet, the way connectWith does with
 * the server's passkey list: the kit still checks the birth against the
 * ledger and that the passkey is a live signer before it will sign.
 */
export async function connectTestWallet(passkey: SoftPasskey, wallet: WalletRecord, origin: string): Promise<Kit> {
  const { kit, storage } = walletKit(passkey, origin);
  await storage.save({
    credentialId: passkey.credentialId,
    publicKey: new Uint8Array(passkey.publicKey),
    contractId: wallet.address,
    createdAt: Date.now(),
    isPrimary: true,
    deploymentStatus: "deployed",
    birthWasmHash: wallet.birthWasmHash,
    creationTransactionHash: wallet.createdTx,
    creationLedger: wallet.creationLedger,
    birthConstructorArgsHash: wallet.birthConstructorArgsHash,
  });
  await kit.connectWallet({ credentialId: passkey.credentialId, contractId: wallet.address });
  return kit;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the wallet holds what payAndRelay requires (the most one write
 * may cost). The relay starts a top-up with every testnet deploy; if that
 * has not arrived in time, the app's Top up route is asked once.
 */
export async function waitForFunds(target: Target, session: Session, address: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let askedForTopUp = false;
  while (Date.now() < deadline) {
    if ((await xlmBalanceStroops(address).catch(() => BigInt(0))) >= MAX_USER_FEE_STROOPS) return;
    if (!askedForTopUp && Date.now() > deadline - timeoutMs / 2) {
      askedForTopUp = true;
      const res = await api(target, session, "/api/chain/topup", {});
      if (res.status !== 200 && res.status !== 409) console.warn(`top-up for ${address}: ${res.status} ${String(res.json.error ?? "")}`);
    }
    await sleep(3_000);
  }
  throw new Error(`${address} was not funded within ${timeoutMs / 1000}s`);
}

/** A new note in the user's vault, through the app's own route; returns its id. */
export async function createNote(target: Target, session: Session, title: string): Promise<{ id: string; markdown: string }> {
  const body = `Load test note.\n\n## Overview\n${title}\n`;
  const res = await api(target, session, "/api/notes", { title, body });
  if (res.status !== 200 || typeof res.json.id !== "string") throw new Error(`creating a note: ${res.status} ${String(res.json.error ?? "")}`);
  // Stored as sent: the title is not part of the text (D-121).
  return { id: res.json.id, markdown: body };
}

/** `register_document` for a new note, built by the bindings client as contract-client.ts does. */
export async function registerCall(wallet: string, docId: string, markdown: string): Promise<xdr.InvokeContractArgs> {
  const registry = new RegistryClient({ contractId: CONTRACT_ID, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL });
  const contentHash = BindingsBuffer.from(createHash("sha256").update(markdown).digest());
  const tx = await registry.register_document({ owner: wallet, doc_id: docId, content_hash: contentHash });
  const op = tx.built?.operations[0] as { func?: xdr.HostFunction } | undefined;
  if (!op?.func || op.func.switch().name !== "hostFunctionTypeInvokeContract") throw new Error("The registry client built no call.");
  return op.func.invokeContract();
}

/**
 * payAndRelay up to the fetch: balance and ledger read together, the
 * forward draft simulated, the wallet's entry signed by the passkey.
 * `relayer` defaults to the app's own (DOQTRI_RELAYER).
 */
export async function prepareForwardedWrite(
  kit: Kit,
  wallet: string,
  call: xdr.InvokeContractArgs,
  relayer: string | null = DOQTRI_RELAYER,
): Promise<RelayBody> {
  if (!FEE_FORWARDER || !relayer) throw new Error("Paid writes aren't available on this network.");
  const server = new rpc.Server(RPC_URL);
  const maxFee = MAX_USER_FEE_STROOPS;
  const [balance, { sequence }] = await Promise.all([xlmBalanceStroops(wallet), server.getLatestLedger()]);
  if (balance < maxFee) throw new Error(`wallet holds ${balance} stroops, below the ${maxFee} a write needs`);

  const draft = forwardDraft(
    { call, wallet, forwarder: FEE_FORWARDER, relayer, xlm: NATIVE_XLM, maxFee, latestLedger: sequence },
    NETWORK_PASSPHRASE,
  );
  const simulation = await server.simulateTransaction(draft);
  if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
    throw new Error(`forward simulation failed: ${rpc.Api.isSimulationError(simulation) ? simulation.error.slice(0, 200) : "no result"}`);
  }
  const entry = walletEntryOf(simulation.result.auth, wallet);
  if (!entry) throw new Error("The forward call needs no approval from the wallet.");
  const signed = await kit.signAuthEntry(entry, { contextRuleIds: Array(callsIn(entry.rootInvocation())).fill(0) });
  return relayBody(draftFunc(draft), signed);
}

/** One measured relay request. Never throws: a failure is an outcome. */
export async function sendPaidWrite(
  target: Target,
  session: Session,
  body: RelayBody,
): Promise<{ status: number; ok: boolean; hash?: string; error?: string; relayMs: number }> {
  const started = performance.now();
  try {
    const { status, json } = await api(target, session, "/api/chain/relay", body);
    const relayMs = performance.now() - started;
    const hash = (json.data as { hash?: string } | undefined)?.hash;
    const ok = status === 200 && json.success === true && typeof hash === "string";
    return { status, ok, hash, error: ok ? undefined : String(json.error ?? ""), relayMs };
  } catch (error) {
    return { status: 0, ok: false, error: (error as Error).message, relayMs: performance.now() - started };
  }
}
