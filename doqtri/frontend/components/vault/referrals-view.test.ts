import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageNav, readReferrals, ReferralsDashboard, ReferralsError, ReferralsView } from "@/components/vault/referrals-view";
import type { ReferralDashboard, ReferralListRow } from "@/lib/referral-dashboard";

/*
 * What the referral dashboard shows (WP-4.6, DOQ-24): rendered to static markup,
 * since the unit tests run in Node without a DOM. The rules' numbers are pinned
 * here as they read on the page.
 */

const row = (over: Partial<ReferralListRow> = {}): ReferralListRow => ({
  identity: "ty•••@gmail.com",
  former: false,
  joinedOn: "2026-11-01",
  activity: 2,
  status: "pending",
  amountPhp: null,
  ...over,
});

const dashboard = (over: Partial<ReferralDashboard> = {}): ReferralDashboard => ({
  rows: [row()],
  page: 1,
  pages: 1,
  pageSize: 20,
  totals: { referred: 1, eligible: 0, earnedPhp: 0, unpaidPhp: 0, paidPhp: 0 },
  limit: { limit: 30, used: 0, reached: false },
  payoutNeeded: false,
  payout: { canEdit: false, summary: null },
  ...over,
});

const NO_ONE = dashboard({ rows: [], totals: { referred: 0, eligible: 0, earnedPhp: 0, unpaidPhp: 0, paidPhp: 0 } });

/** Markup as text, with the entities React escapes put back. */
function text(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

const render = (data: ReferralDashboard, inviteUrl: string | null = "https://doqtri.xyz/r/abcdefgh") =>
  createElement(ReferralsDashboard, { data, inviteUrl });

const LIMIT_NOTICE = "You've reached the limit of 30 rewards. To request more, email team@doqtri.xyz";

describe("the list", () => {
  it("shows a row's masked identity, join date, progress and status", () => {
    const html = text(render(dashboard()));
    expect(html).toContain("ty•••@gmail.com");
    expect(html).toContain("Nov 1, 2026");
    expect(html).toContain("2 / 3");
    expect(html).toContain("Pending");
  });

  it.each([
    ["pending", "Pending"],
    ["eligible", "Eligible"],
    ["over_limit", "Over limit"],
    ["paid", "Paid"],
    ["not_eligible", "Not eligible"],
  ] as const)("names %s as %s", (status, label) => {
    const html = renderToStaticMarkup(render(dashboard({ rows: [row({ status })] })));
    expect(html).toContain(`data-testid="referrals-status">${label}<`);
  });

  it("shows the amount only where the row carries one", () => {
    expect(text(render(dashboard({ rows: [row({ status: "eligible", amountPhp: 30 })] })))).toContain("30 PHP");
    expect(renderToStaticMarkup(render(dashboard({ rows: [row({ status: "over_limit" })] })))).not.toMatch(
      /tabular-nums">\d+ PHP</,
    );
  });

  it("shows a former user by that name, with a dash for the date and for activity", () => {
    const html = renderToStaticMarkup(
      render(
        dashboard({
          rows: [row({ identity: "Former user", former: true, joinedOn: null, activity: null, status: "eligible" })],
        }),
      ),
    );
    expect(html).toContain('data-testid="referrals-identity">Former user<');
    expect(html.match(/—/g)).toHaveLength(2);
    expect(html).not.toContain("/ 3");
    expect(html).not.toContain("2026");
  });

  it("reads the day in UTC, so nobody sees the day before", () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(text(render(dashboard({ rows: [row({ joinedOn: "2026-11-01" })] })))).toContain("Nov 1, 2026");
    } finally {
      process.env.TZ = zone;
    }
  });

  it("offers no paging on a single page, and pages on many", () => {
    expect(renderToStaticMarkup(render(dashboard()))).not.toContain("referrals-next");
    const html = renderToStaticMarkup(
      render(
        dashboard({
          page: 2,
          pages: 3,
          rows: [row(), row()],
          totals: { referred: 42, eligible: 0, earnedPhp: 0, unpaidPhp: 0, paidPhp: 0 },
        }),
      ),
    );
    expect(html).toContain("referrals-next");
    expect(text(render(dashboard({ page: 2, pages: 3, rows: [row(), row()], totals: { referred: 42, eligible: 0, earnedPhp: 0, unpaidPhp: 0, paidPhp: 0 } })))).toContain(
      "21–22 of 42",
    );
  });
});

describe("the totals", () => {
  it("show what the server sent, with thousands marked", () => {
    const html = renderToStaticMarkup(
      render(
        dashboard({
          totals: { referred: 1234, eligible: 12, earnedPhp: 54321, unpaidPhp: 360, paidPhp: 53961 },
          payoutNeeded: true,
        }),
      ),
    );
    const figure = (id: string) => new RegExp(`data-testid="referrals-total-${id}"><span[^>]*>([^<]+)<`).exec(html)?.[1];
    expect(figure("referred")).toBe("1,234");
    expect(figure("eligible")).toBe("12");
    expect(figure("earned")).toBe("54,321");
    expect(figure("unpaid")).toBe("360");
    expect(figure("paid")).toBe("53,961");
  });
});

describe("the limit notice", () => {
  it("doesn't appear below the limit", () => {
    const html = renderToStaticMarkup(render(dashboard({ limit: { limit: 30, used: 29, reached: false } })));
    expect(html).not.toContain("referrals-limit-notice");
    expect(html).not.toContain("mailto:");
  });

  it("appears at the limit in its exact words, with a mailto link", () => {
    const element = render(dashboard({ limit: { limit: 30, used: 30, reached: true } }));
    expect(text(element)).toContain(LIMIT_NOTICE);
    expect(renderToStaticMarkup(element)).toContain('href="mailto:team@doqtri.xyz"');
  });

  it("says the referrer's own limit where it differs", () => {
    expect(text(render(dashboard({ limit: { limit: 50, used: 50, reached: true } })))).toContain(
      "You've reached the limit of 50 rewards.",
    );
    expect(text(render(dashboard({ limit: { limit: 1, used: 1, reached: true } })))).toContain(
      "You've reached the limit of 1 reward.",
    );
  });
});

describe("the payout card (DOQ-25)", () => {
  const UNPAID = { referred: 1, eligible: 1, earnedPhp: 30, unpaidPhp: 30, paidPhp: 0 };
  const card = (html: string, id: string) =>
    new RegExp(`data-testid="referrals-payout-${id}".*?</button></div>`).exec(html)?.[0] ?? "";

  it("asks for details for an unpaid reward, with a button that opens the form, and no form yet", () => {
    const html = renderToStaticMarkup(
      render(dashboard({ payoutNeeded: true, totals: UNPAID, payout: { canEdit: true, summary: null } })),
    );
    const prompt = card(html, "prompt");
    expect(prompt).toContain("Payout details needed");
    expect(prompt).toContain("You have 30 PHP unpaid.");
    expect(prompt).toMatch(/data-testid="referrals-payout-open"[^>]*>Add details</);
    // The form is in a dialog that isn't open: nothing of it is on the page.
    expect(html).not.toContain("<form");
    expect(html).not.toContain('data-testid="payout-dialog"');
  });

  it("once saved, says so with only the masked summary, and offers Edit", () => {
    const html = renderToStaticMarkup(
      render(
        dashboard({
          payoutNeeded: false,
          totals: UNPAID,
          payout: { canEdit: true, summary: { label: "GCash", last4: "4567" } },
        }),
      ),
    );
    expect(html).not.toContain("Payout details needed");
    const saved = card(html, "saved");
    expect(saved).toContain("Payout details saved");
    expect(saved.replace(/<[^>]+>/g, "")).toContain("GCash ending in 4567");
    expect(saved).toMatch(/>Edit</);
  });

  it("offers View instead for someone who can no longer change them", () => {
    const html = renderToStaticMarkup(
      render(dashboard({ payout: { canEdit: false, summary: { label: "XLM", last4: "WXYZ" } } })),
    );
    expect(card(html, "saved")).toMatch(/>View</);
  });

  it("offers to add them to someone eligible with nothing owed right now", () => {
    const html = text(render(dashboard({ payout: { canEdit: true, summary: null } })));
    expect(html).toContain("No payout details saved");
    expect(html).not.toContain("Payout details needed");
  });

  it("names an XLM memo's type, and nothing of the memo itself", () => {
    const html = text(
      render(dashboard({ payout: { canEdit: true, summary: { label: "XLM", last4: "WXYZ", memoType: "id" } } })),
    );
    expect(html).toContain("XLM ending in WXYZ, with an ID memo");
    expect(
      text(render(dashboard({ payout: { canEdit: true, summary: { label: "XLM", last4: "WXYZ", memoType: "text" } } }))),
    ).toContain("XLM ending in WXYZ, with a text memo");
    expect(
      text(render(dashboard({ payout: { canEdit: true, summary: { label: "XLM", last4: "WXYZ", memoType: null } } }))),
    ).not.toContain("memo");
  });

  it("says plainly when the details couldn't be loaded, with nothing to open, and the rest of the page as usual", () => {
    const html = renderToStaticMarkup(
      render(
        dashboard({
          payoutNeeded: false,
          totals: UNPAID,
          payout: { canEdit: true, summary: null, unavailable: true },
        }),
      ),
    );
    const card = /data-testid="referrals-payout-unavailable".*?<\/div><\/div>/.exec(html)?.[0] ?? "";
    expect(card).toContain("Your payout details couldn&#x27;t be loaded");
    expect(card).toContain("Try reloading the page in a moment.");
    expect(html).not.toContain("referrals-payout-open");
    expect(html).not.toContain("Payout details needed");
    expect(html).toContain('data-testid="referrals-totals"');
  });

  it("doesn't appear for someone with neither details nor an eligible referral", () => {
    const html = renderToStaticMarkup(render(dashboard()));
    expect(html).not.toContain("referrals-payout-");
    expect(html).not.toContain("Payout details");
  });
});

describe("the rules panel", () => {
  it("pins every number it states", () => {
    const html = text(render(dashboard()));
    expect(html).toContain("3 or more on-chain activities");
    expect(html).toContain("New activity can take up to 15 minutes to show here.");
    expect(html).toContain("You earn 30 PHP for each eligible referral.");
    expect(html).toContain("paid manually, within 30 days of a referral being eligible and your payout questionnaire being complete");
    expect(html).toContain("You can earn up to 30 rewards.");
  });

  it("gives the referrer's own limit, and appears for someone with no referrals yet", () => {
    expect(text(render(dashboard({ limit: { limit: 50, used: 0, reached: false } })))).toContain(
      "You can earn up to 50 rewards.",
    );
    expect(renderToStaticMarkup(render(NO_ONE))).toContain("referrals-rules");
  });

  it("has no Terms link yet", () => {
    expect(renderToStaticMarkup(render(dashboard()))).not.toMatch(/terms/i);
  });
});

describe("the empty state", () => {
  it("says so and offers to copy the link, with no list or totals", () => {
    const html = renderToStaticMarkup(render(NO_ONE));
    expect(html).toContain("No referrals yet");
    expect(html).toContain("referrals-copy-link");
    expect(html).not.toContain("referrals-list");
    expect(html).not.toContain("referrals-totals");
  });

  it("sends them to the Invite tab if the link couldn't be loaded", () => {
    const html = renderToStaticMarkup(render(NO_ONE, null));
    expect(html).not.toContain("referrals-copy-link");
    expect(html).toContain('href="/vault/profile?tab=invite"');
  });

  it("doesn't hide someone who only has former users", () => {
    const html = renderToStaticMarkup(
      render(
        dashboard({
          rows: [row({ identity: "Former user", former: true, joinedOn: null, activity: null })],
          totals: { referred: 1, eligible: 0, earnedPhp: 0, unpaidPhp: 0, paidPhp: 0 },
        }),
      ),
    );
    expect(html).not.toContain("referrals-empty");
  });
});

describe("turning the page", () => {
  /** A button in the nav by its test id. PageNav has no hooks, so it can be called and its tree read. */
  function button(testId: string, props: Partial<Parameters<typeof PageNav>[0]> = {}) {
    const onPage = vi.fn();
    const nav = PageNav({ page: 2, pages: 3, start: 20, shown: 20, total: 45, busy: false, onPage, ...props });
    const buttons = (nav.props as { children: ReactElement<Record<string, unknown>>[] }).children;
    const found = buttons.find((child) => child.props["data-testid"] === testId)!;
    return { props: found.props as { disabled: boolean; focusableWhenDisabled: boolean; onClick: () => void }, onPage };
  }

  it("Next asks for the next page, and Previous the one before", () => {
    const next = button("referrals-next");
    next.props.onClick();
    expect(next.onPage).toHaveBeenCalledWith(3);
    const previous = button("referrals-prev");
    previous.props.onClick();
    expect(previous.onPage).toHaveBeenCalledWith(1);
  });

  it("neither goes past the ends", () => {
    expect(button("referrals-prev", { page: 1 }).props.disabled).toBe(true);
    expect(button("referrals-next", { page: 1 }).props.disabled).toBe(false);
    expect(button("referrals-next", { page: 3 }).props.disabled).toBe(true);
    expect(button("referrals-prev", { page: 3 }).props.disabled).toBe(false);
  });

  it("both wait while a page loads, and neither drops a keyboard user's focus", () => {
    for (const id of ["referrals-prev", "referrals-next"]) {
      const { props } = button(id, { busy: true });
      expect(props.disabled).toBe(true);
      expect(props.focusableWhenDisabled).toBe(true);
    }
  });

  const failedTurn = () =>
    renderToStaticMarkup(
      createElement(ReferralsDashboard, {
        data: dashboard({ page: 2, pages: 3, totals: { referred: 45, eligible: 0, earnedPhp: 0, unpaidPhp: 0, paidPhp: 0 } }),
        inviteUrl: null,
        pageError: "Your referrals couldn't be loaded.",
      }),
    );

  it("a failed turn says so where the list is, and keeps the list", () => {
    const html = failedTurn();
    expect(html).toContain("referrals-page-error");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
    expect(html).toContain("referrals-list");
    expect(html).toContain("referrals-totals");
    expect(html).toContain("referrals-next");
  });

  it("a page that loaded has no error", () => {
    expect(renderToStaticMarkup(render(dashboard()))).not.toContain("referrals-page-error");
  });
});

describe("reading from the route", () => {
  const FAILED = "Your referrals couldn't be loaded.";
  afterEach(() => vi.unstubAllGlobals());

  const answering = (response: Response | Error) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (response instanceof Error) throw response;
        return response;
      }),
    );

  it("asks for the page, never from a cache", async () => {
    answering(Response.json(dashboard()));
    expect(await readReferrals(3)).toEqual({ kind: "ready", data: dashboard() });
    expect(fetch).toHaveBeenCalledWith("/api/referrals?page=3", { cache: "no-store" });
  });

  it("passes on the route's own words", async () => {
    answering(Response.json({ error: "Sign in to continue." }, { status: 401 }));
    expect(await readReferrals(1)).toEqual({ kind: "error", message: "Sign in to continue." });
  });

  it("says its own for a dropped connection, not the browser's", async () => {
    answering(new TypeError("Failed to fetch"));
    expect(await readReferrals(1)).toEqual({ kind: "error", message: FAILED });
  });

  it("treats anything without totals as a failure, rather than break the page", async () => {
    answering(new Response("<html></html>", { status: 200 }));
    expect(await readReferrals(1)).toEqual({ kind: "error", message: FAILED });
    answering(Response.json({}));
    expect(await readReferrals(1)).toEqual({ kind: "error", message: FAILED });
  });
});

describe("loading and error states", () => {
  it("starts out loading", () => {
    const html = renderToStaticMarkup(createElement(ReferralsView, { inviteUrl: null }));
    expect(html).toContain("referrals-loading");
    expect(html).toContain("Loading your referrals");
    expect(html).not.toContain("referrals-totals");
  });

  it("an error says so as an alert, and offers to try again", () => {
    const html = renderToStaticMarkup(createElement(ReferralsError, { message: "Your referrals couldn't be loaded.", onRetry: vi.fn() }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
  });
});
