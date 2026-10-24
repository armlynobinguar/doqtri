import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QditMilestoneCard, QditMilestoneCardView } from "@/components/integrations/qdit-milestone-card";
import type { MilestoneCardState, MilestonePreview } from "@/lib/integrations/qdit-milestone-card";

/*
 * What each of the milestone card's states renders (WP-2.6). Rendered to
 * static markup, since the unit tests run in Node without a DOM; the
 * fetching wrapper is checked only for its first render.
 */

const MILESTONE: MilestonePreview = {
  id: "b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61",
  title: "Escrow contract",
  status: "submitted",
  due_date: "2026-11-15",
  url: "https://qdit.atalusan.com/projects/soroban-payroll/milestones",
  project: { id: "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34", name: "Soroban payroll", slug: "soroban-payroll" },
  node: { id: "h4", label: "Escrow contract" },
  anchor: {
    network: "testnet",
    version: 2,
    last_action: "submit",
    last_tx_hash: "5e1f0c3a9b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a3c5e7b9d0f",
    anchored_at: "2026-10-22T08:11:40.000Z",
  },
  updated_at: "2026-10-22T08:11:40.000Z",
};

const FALLBACK = "https://qdit.atalusan.com/projects/soroban-payroll/milestones";

const view = (state: MilestoneCardState, extra: { showTitle?: boolean; fallbackUrl?: string | null } = {}) =>
  renderToStaticMarkup(createElement(QditMilestoneCardView, { state, ...extra }));

describe("QditMilestoneCardView", () => {
  it("loaded: title, qdit status and its node status, project, due date, anchor and Open in qdit", () => {
    const html = view({ state: "loaded", milestone: MILESTONE });
    expect(html).toContain('data-state="loaded"');
    expect(html).toContain("Escrow contract");
    expect(html).toContain("Submitted");
    expect(html).toContain("Node: Built");
    expect(html).toContain("Soroban payroll");
    expect(html).toContain("Due ");
    expect(html).toContain("Submitted on chain, v2");
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/tx/${MILESTONE.anchor!.last_tx_hash}"`);
    expect(html).toContain(`href="${MILESTONE.url}"`);
    expect(html).toContain("Open in qdit");
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("loaded: each status maps per D-19", () => {
    const cases = [
      ["proposed", "Proposed", "Node: Planned"],
      ["submitted", "Submitted", "Node: Built"],
      ["approved", "Approved", "Node: Verified"],
      ["rejected", "Rejected", "Node: Building"],
    ] as const;
    for (const [status, label, node] of cases) {
      const html = view({ state: "loaded", milestone: { ...MILESTONE, status } });
      expect(html).toContain(label);
      expect(html).toContain(node);
    }
  });

  it("loaded: an unknown status, no anchor, no due date and no URL", () => {
    const html = view({ state: "loaded", milestone: { ...MILESTONE, status: null, anchor: null, due_date: null, url: null } });
    expect(html).toContain("Unknown status");
    expect(html).not.toContain("Node:");
    expect(html).toContain("Not on chain yet");
    expect(html).not.toContain("Due ");
    expect(html).not.toContain("Open in qdit");
  });

  it("loaded: the title can be left to the heading above it", () => {
    const html = view({ state: "loaded", milestone: { ...MILESTONE, title: "Only in qdit" } }, { showTitle: false });
    expect(html).not.toContain("Only in qdit");
  });

  it("no-access: says so and nothing about the milestone, not even the stored link", () => {
    const html = view({ state: "no_access" }, { fallbackUrl: FALLBACK });
    expect(html).toContain('data-state="no_access"');
    expect(html).toContain("You don&#x27;t have access to this milestone in qdit");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("Connect qdit");
  });

  it("not-connected: a connect prompt", () => {
    const html = view({ state: "not_connected", connection: "none" });
    expect(html).toContain('data-state="not_connected"');
    expect(html).toContain("Connect your qdit account to see this milestone.");
    expect(html).toContain('href="/api/integrations/qdit/connect"');
    expect(html).toContain("Connect qdit");
  });

  it("not-connected: a reconnect prompt, and the stored qdit page", () => {
    const html = view({ state: "not_connected", connection: "needs_reconnect" }, { fallbackUrl: FALLBACK });
    expect(html).toContain("Reconnect qdit");
    expect(html).toContain("expired or was revoked");
    expect(html).toContain(`href="${FALLBACK}"`);
  });

  it("never links a stored URL that isn't http(s)", () => {
    const html = view({ state: "not_connected", connection: "none" }, { fallbackUrl: "javascript:alert(1)" });
    expect(html).not.toContain("javascript:");
  });

  it("error: the message, the wait, and a retry", () => {
    const html = renderToStaticMarkup(
      createElement(QditMilestoneCardView, {
        state: { state: "error", message: "qdit is busy. Try again in a moment.", retryAfterSeconds: 9 },
        onRetry: () => undefined,
      }),
    );
    expect(html).toContain('data-state="error"');
    expect(html).toContain("qdit is busy");
    expect(html).toContain("(about 9s)");
    expect(html).toContain("Retry");
  });

  it("loading", () => {
    const html = view({ state: "loading" });
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-busy="true"');
  });
});

describe("QditMilestoneCard", () => {
  it("starts loading, and asks nothing before it is mounted", () => {
    const html = renderToStaticMarkup(createElement(QditMilestoneCard, { milestoneId: MILESTONE.id }));
    expect(html).toContain('data-state="loading"');
  });

  it("shows the connect prompt at once when the caller knows there is no connection", () => {
    expect(
      renderToStaticMarkup(createElement(QditMilestoneCard, { milestoneId: MILESTONE.id, connection: "none" })),
    ).toContain('data-state="not_connected"');
    expect(
      renderToStaticMarkup(
        createElement(QditMilestoneCard, { milestoneId: MILESTONE.id, connection: "needs_reconnect" }),
      ),
    ).toContain("Reconnect qdit");
  });
});
