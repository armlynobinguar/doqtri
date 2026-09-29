import { Horizon, NotFoundError } from "@stellar/stellar-sdk";
import { HORIZON_URL, IS_MAINNET } from "@/lib/stellar/config";
import { DoqtriError } from "@/lib/stellar/errors";

/** Stellar's base reserve: each account entry and subentry locks this much XLM. */
const BASE_RESERVE_XLM = 0.5;

/**
 * Headroom on top of the simulated fee. Resource fees are re-metered at
 * submission and can come out slightly higher than simulated.
 */
const FEE_MARGIN_XLM = 0.02;

const FUND_HINT = IS_MAINNET ? "Fund it with XLM, then retry." : "Fund it with Friendbot, then retry.";

export type AccountBalance =
  | { funded: false }
  | {
      funded: true;
      /** Native balance as Horizon reports it. */
      balance: number;
      /** What can actually be spent: balance minus the locked reserve and liabilities. */
      spendable: number;
    };

type NativeAccountFields = {
  balances: { asset_type: string; balance: string; selling_liabilities?: string }[];
  subentry_count: number;
  num_sponsoring?: number;
  num_sponsored?: number;
};

/**
 * Spendable native XLM. A flat floor (the old check used 1.5 XLM) is wrong in
 * both directions: an account with trustlines or offers locks more than 1 XLM,
 * and a bare account can pay a 0.05 XLM fee with far less than 1.5 spare.
 */
export function spendableXlm(account: NativeAccountFields): { balance: number; spendable: number } {
  const native = account.balances.find((b) => b.asset_type === "native");
  const balance = native ? Number.parseFloat(native.balance) : 0;
  const liabilities = native?.selling_liabilities ? Number.parseFloat(native.selling_liabilities) : 0;
  const entries =
    2 + account.subentry_count + (account.num_sponsoring ?? 0) - (account.num_sponsored ?? 0);
  const spendable = balance - entries * BASE_RESERVE_XLM - liabilities;
  return { balance, spendable: Math.max(0, spendable) };
}

export async function getAccountBalance(address: string): Promise<AccountBalance> {
  try {
    const account = await new Horizon.Server(HORIZON_URL).loadAccount(address);
    return { funded: true, ...spendableXlm(account) };
  } catch (error) {
    if (error instanceof NotFoundError) return { funded: false };
    throw new DoqtriError("HORIZON", "Could not read the account balance from Horizon.");
  }
}

/** Before building a transaction: the account has to exist to be simulated against. */
export async function assertFunded(address: string): Promise<void> {
  const account = await getAccountBalance(address);
  if (!account.funded) {
    throw new DoqtriError(
      "NOT_FUNDED",
      `This account is not on ${IS_MAINNET ? "mainnet" : "testnet"} yet. ${FUND_HINT}`,
    );
  }
}

/**
 * After simulation, before the wallet opens: can the account pay this fee?
 * `feeStroops` is the assembled transaction's total fee, resource fee included.
 */
export async function assertCanPay(address: string, feeStroops: number): Promise<void> {
  const account = await getAccountBalance(address);
  if (!account.funded) {
    throw new DoqtriError(
      "NOT_FUNDED",
      `This account is not on ${IS_MAINNET ? "mainnet" : "testnet"} yet. ${FUND_HINT}`,
    );
  }
  const needed = feeStroops / 1e7 + FEE_MARGIN_XLM;
  if (account.spendable < needed) {
    throw new DoqtriError(
      "NOT_FUNDED",
      `This transaction needs about ${needed.toFixed(3)} XLM, but only ` +
        `${account.spendable.toFixed(3)} XLM is spendable. ${FUND_HINT}`,
    );
  }
}

/** Testnet only: asks Friendbot to fund (or top up) an account. */
export async function fundWithFriendbot(address: string): Promise<void> {
  if (IS_MAINNET) throw new DoqtriError("MAINNET", "Friendbot only exists on testnet.");
  const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`);
  // Friendbot answers 400 for an account it has already funded; that is fine.
  if (!res.ok && res.status !== 400) {
    throw new DoqtriError("FRIENDBOT", `Friendbot failed (${res.status}). Try again shortly.`);
  }
}
