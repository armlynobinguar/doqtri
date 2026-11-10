import { describe, expect, it, vi } from "vitest";
import { createReferralsPager, type ReferralsRead } from "@/components/vault/referrals-pager";
import type { ReferralDashboard } from "@/lib/referral-dashboard";

/** The dashboard's paging (WP-4.6, DOQ-24): what a turn asks for, and what a failed or late one does. */

const dashboard = (page: number): ReferralDashboard => ({
  rows: [],
  page,
  pages: 3,
  pageSize: 20,
  totals: { referred: 45, eligible: 0, earnedPhp: 0, unpaidPhp: 0, paidPhp: 0 },
  limit: { limit: 30, used: 0, reached: false },
  payoutNeeded: false,
  payout: { canEdit: false, summary: null },
});

const ready = (page: number): ReferralsRead => ({ kind: "ready", data: dashboard(page) });
const failed: ReferralsRead = { kind: "error", message: "Nope." };

/** A read that answers only when told to, so answers can come in any order. */
function controlledRead() {
  const pending: ((result: ReferralsRead) => void)[] = [];
  const read = vi.fn<(page: number) => Promise<ReferralsRead>>(() => new Promise((resolve) => pending.push(resolve)));
  return { read, answer: (index: number, result: ReferralsRead) => pending[index](result) };
}

describe("the referrals pager", () => {
  it("starts out busy, with nothing to show", () => {
    expect(createReferralsPager(vi.fn()).getState()).toEqual({ data: null, busy: true, error: null, page: 1 });
  });

  it("asks for the page it's told to, and shows it", async () => {
    const read = vi.fn(async (page: number) => ready(page));
    const pager = createReferralsPager(read);
    await pager.goTo(2);
    expect(read).toHaveBeenCalledWith(2);
    expect(pager.getState()).toEqual({ data: dashboard(2), busy: false, error: null, page: 2 });
  });

  it("is busy during a turn, and keeps the page on screen meanwhile", async () => {
    const { read, answer } = controlledRead();
    const pager = createReferralsPager(read);
    const first = pager.goTo(1);
    answer(0, ready(1));
    await first;
    const turn = pager.goTo(2);
    expect(pager.getState()).toMatchObject({ busy: true, page: 2, data: dashboard(1) });
    answer(1, ready(2));
    await turn;
    expect(pager.getState()).toMatchObject({ busy: false, data: dashboard(2) });
  });

  it("takes the server's page when it answers with another", async () => {
    const pager = createReferralsPager(async () => ready(3));
    await pager.goTo(99);
    expect(pager.getState()).toMatchObject({ page: 3, data: dashboard(3) });
  });

  it("keeps the page on screen when a turn fails, and says why", async () => {
    const read = vi.fn(async (page: number) => (page === 2 ? failed : ready(page)));
    const pager = createReferralsPager(read);
    await pager.goTo(1);
    await pager.goTo(2);
    expect(pager.getState()).toEqual({ data: dashboard(1), busy: false, error: "Nope.", page: 2 });
  });

  it("retries the page that was asked for, not the first", async () => {
    const answers = [ready(1), failed, ready(2)];
    const read = vi.fn(async () => answers.shift()!);
    const pager = createReferralsPager(read);
    await pager.goTo(1);
    await pager.goTo(2);
    await pager.retry();
    expect(read.mock.calls).toEqual([[1], [2], [2]]);
    expect(pager.getState()).toEqual({ data: dashboard(2), busy: false, error: null, page: 2 });
  });

  it("keeps the error up during a retry, and clears it only on success", async () => {
    const { read, answer } = controlledRead();
    const pager = createReferralsPager(read);
    const first = pager.goTo(1);
    answer(0, failed);
    await first;
    const retry = pager.retry();
    expect(pager.getState()).toMatchObject({ busy: true, error: "Nope." });
    answer(1, failed);
    await retry;
    expect(pager.getState()).toMatchObject({ busy: false, error: "Nope.", data: null });
    const again = pager.retry();
    answer(2, ready(1));
    await again;
    expect(pager.getState()).toMatchObject({ busy: false, error: null, data: dashboard(1) });
  });

  it("drops an older answer that arrives late", async () => {
    const { read, answer } = controlledRead();
    const pager = createReferralsPager(read);
    const older = pager.goTo(2);
    const newer = pager.goTo(3);
    answer(1, ready(3));
    await newer;
    answer(0, ready(2));
    await older;
    expect(pager.getState()).toEqual({ data: dashboard(3), busy: false, error: null, page: 3 });
  });

  it("drops an older failure too, and stays busy for the newer request", async () => {
    const { read, answer } = controlledRead();
    const pager = createReferralsPager(read);
    const older = pager.goTo(2);
    const newer = pager.goTo(3);
    answer(0, failed);
    await older;
    expect(pager.getState()).toMatchObject({ busy: true, error: null, page: 3 });
    answer(1, ready(3));
    await newer;
    expect(pager.getState()).toMatchObject({ busy: false, error: null, data: dashboard(3) });
  });

  it("tells whoever's listening, until they stop", async () => {
    const pager = createReferralsPager(async (page) => ready(page));
    const listener = vi.fn();
    const stop = pager.subscribe(listener);
    await pager.goTo(1);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    await pager.goTo(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
