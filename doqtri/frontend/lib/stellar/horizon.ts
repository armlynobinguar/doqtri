import { HORIZON_URL, IS_MAINNET } from "@/lib/stellar/config";
import { DoqtriError } from "@/lib/stellar/errors";

/**
 * 1 XLM base reserve stays locked, so this is the reserve plus headroom for
 * several writes. A mainnet register measures at 0.063 XLM against 0.041 on
 * testnet — close enough that one floor covers both.
 */
const MIN_XLM = 1.5;

const FUND_HINT = IS_MAINNET
  ? "Fund it with XLM, then retry."
  : "Fund via Friendbot, then retry.";

export async function assertFunded(address: string): Promise<void> {
  const res = await fetch(`${HORIZON_URL}/accounts/${address}`);
  if (res.status === 404) {
    throw new DoqtriError(
      "NOT_FUNDED",
      `Account not on ${IS_MAINNET ? "mainnet" : "testnet"} yet. ${FUND_HINT}`,
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
