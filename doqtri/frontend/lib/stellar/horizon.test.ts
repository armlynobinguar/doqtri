import { describe, expect, it } from "vitest";
import { spendableXlm } from "@/lib/stellar/horizon";

const account = (balance: string, extra: Partial<Parameters<typeof spendableXlm>[0]> = {}) => ({
  balances: [{ asset_type: "native", balance, selling_liabilities: "0.0000000" }],
  subentry_count: 0,
  ...extra,
});

describe("spendableXlm", () => {
  it("holds back the 1 XLM base reserve of a bare account", () => {
    expect(spendableXlm(account("10.0000000"))).toEqual({ balance: 10, spendable: 9 });
  });

  it("holds back 0.5 XLM per subentry", () => {
    expect(spendableXlm(account("10", { subentry_count: 3 })).spendable).toBe(7.5);
  });

  it("accounts for sponsorship in both directions", () => {
    expect(spendableXlm(account("10", { num_sponsoring: 2, num_sponsored: 1 })).spendable).toBe(8.5);
  });

  it("subtracts selling liabilities", () => {
    const withOffer = {
      balances: [{ asset_type: "native", balance: "10", selling_liabilities: "4" }],
      subentry_count: 1,
    };
    expect(spendableXlm(withOffer).spendable).toBe(4.5);
  });

  it("never reports a negative spendable amount", () => {
    expect(spendableXlm(account("0.8")).spendable).toBe(0);
  });

  it("treats a missing native line as zero", () => {
    expect(spendableXlm({ balances: [], subentry_count: 0 })).toEqual({ balance: 0, spendable: 0 });
  });
});
