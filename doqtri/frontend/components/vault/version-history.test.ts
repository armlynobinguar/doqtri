import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hasVersionHistory, VersionHistory } from "@/components/vault/version-history";
import type { DocumentHistory } from "@/lib/stellar/history";

/*
 * The ship panel's version history with a paid write the relay answered 202
 * for (DOQ-5). Rendered to static markup, since the unit tests run in Node
 * without a DOM.
 */

const v1 = {
  version: 1,
  contentHash: "11".repeat(32),
  txHash: "aa".repeat(32),
  closedAt: "2026-11-01T11:00:00Z",
  signer: null,
  signerFrom: "owner" as const,
};
const sent = { txHash: "bb".repeat(32), fn: "update_document", createdAt: "2026-11-01T11:59:30Z" };
const base: DocumentHistory = { owner: "C" + "A".repeat(55), versions: [v1], nodeEvents: [], nodes: [] };

const render = (history: DocumentHistory) => renderToStaticMarkup(createElement(VersionHistory, { history }));

describe("VersionHistory", () => {
  it("shows a Pending badge, linked to its transaction, for a write no ledger has yet", () => {
    const html = render({ ...base, pending: [sent] });
    expect(html).toContain('data-testid="version-pending"');
    expect(html).toContain("Pending");
    expect(html).toContain(sent.txHash);
    expect(html).toContain("Version history (1, 1 pending)");
  });

  it("shows no badge once the write is confirmed: it is a version like any other", () => {
    const html = render({ ...base, versions: [v1, { ...v1, version: 2, txHash: sent.txHash }] });
    expect(html).not.toContain("version-pending");
    expect(html).not.toContain("Pending");
    expect(html).toContain("v2");
    expect(html).toContain("Version history (2)");
  });

  it("is shown for a note the ledger doesn't have yet, whose first anchor is pending", () => {
    // What the ship panel passes when get_document is null (readPendingWrites).
    const first = { versions: [], pending: [{ ...sent, fn: "register_document" }] };
    expect(hasVersionHistory(first)).toBe(true);
    const html = renderToStaticMarkup(createElement(VersionHistory, { history: first }));
    expect(html).toContain('data-testid="version-pending"');
    expect(html).toContain("Version history (0, 1 pending)");
    expect(hasVersionHistory({ versions: [] })).toBe(false);
    expect(hasVersionHistory(null)).toBe(false);
  });

  it("lists only pending writes that make a version, not a pending node status", () => {
    const node = { txHash: "cc".repeat(32), fn: "set_node_status", createdAt: sent.createdAt };
    const html = render({ ...base, pending: [node] });
    expect(html).not.toContain("version-pending");
    expect(html).toContain("Version history (1)");
    expect(hasVersionHistory({ versions: [], pending: [node] })).toBe(false);
  });
});
