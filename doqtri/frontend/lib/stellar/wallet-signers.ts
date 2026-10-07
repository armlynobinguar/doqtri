/**
 * Reads which passkeys a smart wallet accepts, from the chain (server-only).
 *
 * Every Doqtri wallet has one context rule (id 0, "Default") whose signers are
 * the wallet's passkeys. The ledger is authoritative; `wallet_passkeys` is a
 * copy the relay keeps in step with it.
 */
import { Client } from "smart-account-kit-bindings";
import { NETWORK_PASSPHRASE, RPC_URL } from "@/lib/stellar/config";
import { WEBAUTHN_VERIFIER } from "@/lib/stellar/smart-wallet-config";

export type OnChainPasskey = { signerId: number; publicKey: Buffer; credentialId: Buffer };

export async function readWalletPasskeys(address: string): Promise<OnChainPasskey[]> {
  const client = new Client({ contractId: address, networkPassphrase: NETWORK_PASSPHRASE, rpcUrl: RPC_URL });
  const rule = (await client.get_context_rule({ context_rule_id: 0 })).result;
  const passkeys: OnChainPasskey[] = [];
  rule.signers.forEach((signer, index) => {
    if (signer.tag !== "External" || signer.values[0] !== WEBAUTHN_VERIFIER) return;
    const keyData = Buffer.from(signer.values[1]);
    if (keyData.length <= 65) return;
    passkeys.push({
      signerId: Number(rule.signer_ids[index]),
      publicKey: keyData.subarray(0, 65),
      credentialId: keyData.subarray(65),
    });
  });
  return passkeys;
}
