/**
 * Proves the load test's headless signing on testnet without a deployment
 * (DOQ-2, WP-4.1): a software-passkey wallet is deployed, funded, signs one
 * forwarded register exactly as the load test prepares it, and the relay's
 * own submitPaidWrite lands it. Everything uses fresh throwaway keys,
 * including the relayer (the FeeForwarder accepts any relayer that signs),
 * so no app secret, database or Channels key is involved. It writes one
 * junk document, owned by the throwaway wallet, to the testnet registry.
 *
 *   npx vitest run --config scripts/load-test/vitest.config.mts smoke
 */
import { Keypair, Operation, rpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { expect, it } from "vitest";
import { createSoftPasskey } from "./soft-passkey";

const ORIGIN = "http://localhost:3000";

async function friendbot(address: string) {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${address}`);
  if (!res.ok) throw new Error(`Friendbot refused ${address}: ${res.status}`);
}

it("a software passkey's forwarded write lands through submitPaidWrite", async () => {
  // A relayer of our own: smart-wallet-config reads it when first imported.
  const relayer = Keypair.random();
  process.env.NEXT_PUBLIC_DOQTRI_RELAYER = relayer.publicKey();
  process.env.DOQTRI_RELAYER_SECRET = relayer.secret();
  await friendbot(relayer.publicKey());

  const { IS_MAINNET, NETWORK_PASSPHRASE, RPC_URL } = await import("@/lib/stellar/config");
  if (IS_MAINNET) throw new Error("testnet only");
  const { buildWalletDeploy, connectTestWallet, ledgerOf, prepareForwardedWrite, registerCall, walletKit } = await import("./driver");
  const { topUpWallet } = await import("@/lib/stellar/friendbot-topup");
  const { submitPaidWrite } = await import("@/lib/stellar/direct-submit");
  const { parseRelayBody, validateForwardedWrite } = await import("@/lib/stellar/relay-validation");
  const smartWallet = await import("@/lib/stellar/smart-wallet-config");
  const { CONTRACT_ID } = await import("@/lib/stellar/config");

  // 1. Deploy the wallet from the kit's {func, auth}, sourced by the throwaway
  //    account the way Channels sources it for the relay.
  const passkey = createSoftPasskey();
  const { kit, storage } = walletKit(passkey, ORIGIN);
  const built = await buildWalletDeploy(kit, storage, passkey);
  const server = new rpc.Server(RPC_URL);
  const deploy = new TransactionBuilder(await server.getAccount(relayer.publicKey()), { fee: "100000", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.fromXDR(built.payload.func, "base64"),
        auth: built.payload.auth.map((a) => xdr.SorobanAuthorizationEntry.fromXDR(a, "base64")),
      }),
    )
    .setTimeout(60)
    .build();
  const prepared = await server.prepareTransaction(deploy);
  prepared.sign(relayer);
  const sent = await server.sendTransaction(prepared);
  expect(sent.status).toBe("PENDING");
  const creationLedger = await ledgerOf(sent.hash);
  console.log(`wallet ${built.address} deployed in ${sent.hash}`);

  // 2. Fund it as the relay's first top-up does.
  await topUpWallet(built.address);

  // 3. Connect and sign one paid register, as the load test prepares it.
  const record = { address: built.address, createdTx: sent.hash, creationLedger, birthWasmHash: built.birthWasmHash, birthConstructorArgsHash: built.birthConstructorArgsHash };
  const connected = await connectTestWallet(passkey, record, ORIGIN);
  const docId = `loadtest-smoke-${Date.now().toString(36)}`;
  const body = await prepareForwardedWrite(connected, built.address, await registerCall(built.address, docId, docId), relayer.publicKey());

  // 4. The relay's own checks and submission.
  const submission = parseRelayBody(body);
  const write = validateForwardedWrite(submission, {
    forwarder: smartWallet.FEE_FORWARDER!,
    xlm: smartWallet.NATIVE_XLM,
    registry: CONTRACT_ID,
    wallet: built.address,
    relayer: relayer.publicKey(),
    maxFeeCap: smartWallet.MAX_USER_FEE_STROOPS,
  });
  const { hash, feeStroops } = await submitPaidWrite(submission.func, submission.auth[0], write.maxFee);
  console.log(`paid register ${docId} landed in ${hash}, fee ${feeStroops} stroops`);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
}, 300_000);
