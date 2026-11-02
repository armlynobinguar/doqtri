import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => [] as [string, string][]);
vi.mock("sonner", () => ({
  toast: {
    info: (text: string) => toasts.push(["info", text]),
    success: (text: string) => toasts.push(["success", text]),
    error: (text: string) => toasts.push(["error", text]),
  },
}));

const { announceWrite, PENDING_TOAST, ReceiptCard } = await import("@/components/vault/receipt-card");
type Receipt = import("@/components/vault/receipt-card").Receipt;

/*
 * The ship panel's receipt for a write the relay answered 202 for (DOQ-5):
 * "sent" with a Pending badge, not a confirmed version. Rendered to static
 * markup, since the unit tests run in Node without a DOM.
 */

const txHash = "ab".repeat(32);
const render = (receipt: Receipt) =>
  renderToStaticMarkup(createElement(ReceiptCard, { receipt, onCopyHash: () => {} }));

describe("ReceiptCard", () => {
  it("a pending write: says sent, shows the Pending badge and no version", () => {
    const html = render({ txHash, pending: true, kind: "register", contentHash: "11".repeat(32) });
    expect(html).toContain("Registered: sent");
    expect(html).toContain('data-testid="receipt-pending"');
    expect(html).toContain("Pending");
    expect(html).not.toMatch(/>v\d/);
    expect(html).toContain(txHash);
  });

  it("a confirmed write: shows its version and no badge", () => {
    const html = render({ txHash, version: 2, kind: "update" });
    expect(html).toContain("Updated");
    expect(html).not.toContain("sent");
    expect(html).not.toContain("receipt-pending");
    expect(html).toContain(">v2<");
  });

  it("announces a pending write as information, never as an error", () => {
    toasts.length = 0;
    announceWrite({ txHash, pending: true }, "Saved & registered as v1");
    announceWrite({ txHash, version: 1 }, "Saved & registered as v1");
    expect(toasts).toEqual([
      ["info", PENDING_TOAST],
      ["success", "Saved & registered as v1"],
    ]);
  });
});
