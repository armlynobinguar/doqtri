import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityList, writeActivity } from "@/components/vault/activity-list";

/*
 * The account page's recent activity for a passkey wallet, read from
 * chain_writes, with paid writes the relay answered 202 for (DOQ-5).
 * Rendered to static markup, since the unit tests run in Node without a DOM.
 */

const row = (status?: string) => ({ tx_hash: "ab".repeat(32), fn: "anchor", created_at: "2026-11-01T12:00:00Z", status });
const render = (status?: string) =>
  renderToStaticMarkup(createElement(ActivityList, { activity: [writeActivity(row(status), "Plan")] }));

describe("recent on-chain activity", () => {
  it("shows a Pending badge for a pending write, not an error", () => {
    const html = render("pending");
    expect(html).toContain('data-testid="activity-pending"');
    expect(html).toContain("Anchored a note");
    expect(html).not.toContain("text-warning");
  });

  it("drops the badge once the chain-jobs run marks the write confirmed", () => {
    expect(render("confirmed")).not.toContain("activity-pending");
    // Rows from before DOQ-5 carry no status.
    expect(render(undefined)).not.toContain("activity-pending");
  });

  it("marks a write that failed on-chain as failed", () => {
    const html = render("failed");
    expect(html).not.toContain("activity-pending");
    expect(html).toContain("Anchored a note (failed)");
    expect(html).toContain("text-warning");
  });

  it("maps a row to its label, note title and time", () => {
    expect(writeActivity(row("pending"), "Plan")).toEqual({
      hash: "ab".repeat(32),
      label: "Anchored a note",
      detail: "Plan",
      at: "2026-11-01T12:00:00Z",
      ok: true,
      pending: true,
    });
  });
});
