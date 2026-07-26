import { HORIZON_URL } from "@/lib/stellar/config";
import { DoqtriError } from "@/lib/stellar/errors";

const MIN_XLM = 1.5;

export async function assertFunded(address: string): Promise<void> {
  const res = await fetch(`${HORIZON_URL}/accounts/${address}`);
  if (res.status === 404) {
    throw new DoqtriError(
      "NOT_FUNDED",
      "Account not on testnet yet. Fund via Friendbot, then retry.",
    );
  }
  if (!res.ok) {
    throw new DoqtriError("HORIZON", `Horizon error (${res.status})`);
  }
  const body = (await res.json()) as {
    balances?: { asset_type: string; balance: string }[];
  };
  const native = body.balances?.find((b) => b.asset_type === "native");
  const bal = native ? parseFloat(native.balance) : 0;
  if (bal < MIN_XLM) {
    throw new DoqtriError(
      "NOT_FUNDED",
      `Need ~${MIN_XLM} XLM for fees (have ${bal.toFixed(2)}). Fund the account and retry.`,
    );
  }
}
