import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QditReceiptsSection } from "@/components/audit/qdit-receipts";
import { parseQditArtifactRef } from "@/lib/integrations/qdit-chain";
import type { QditReceipt, QditReceipts } from "@/lib/integrations/qdit-receipts";

/*
 * What the public page's qdit receipts render in each state (WP-3.1).
 * Static markup, since the unit tests run in Node without a DOM.
 */

const CONTRACT = "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG";
const REF = `qdit:testnet:${CONTRACT}:3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34/c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72@v2`;
const SIGNING_TX = "1".repeat(64);
const APPROVAL_TX = "5e1f0c3a9b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a3c5e7b9d0f";
const SIGNER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

const CONFIRMED: QditReceipt = {
  nodeId: "h4",
  record: { status: "Verified", artifactRef: REF },
  ref: parseQditArtifactRef(REF),
  signing: {
    nodeId: "h4",
    status: "Verified",
    tool: "qdit",
    artifactRef: REF,
    txHash: SIGNING_TX,
    closedAt: "2026-10-24T12:00:00Z",
    docVersion: 3,
    signer: SIGNER,
    signerFrom: "call",
  },
  check: { state: "confirmed", chain: { status: "Approved", version: 2 }, ledger: 1234567 },
  approvalTxHash: APPROVAL_TX,
};

const render = (receipts: QditReceipt[], more = 0, labels: Map<string, string> | null = null) =>
  renderToStaticMarkup(
    createElement(QditReceiptsSection, { receipts: { receipts, more } satisfies QditReceipts, labels }),
  );

describe("QditReceiptsSection", () => {
  it("confirmed: approved on chain, with doqtri's signing transaction and qdit's approval transaction", () => {
    const html = render([CONFIRMED]);
    expect(html).toContain('data-state="confirmed"');
    expect(html).toContain("Approved on chain");
    expect(html).toContain("Doqtri recorded");
    expect(html).toContain(" against milestone v2");
    expect(html).toContain("Approved</strong> at v2");
    expect(html).toContain("ledger 1,234,567");
    // doqtri's own write, on doqtri's network (testnet by default).
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/tx/${SIGNING_TX}"`);
    expect(html).toContain("signing transaction →");
    // qdit's approval, on the ref's network.
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/tx/${APPROVAL_TX}"`);
    expect(html).toContain("Approval transaction →");
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/contract/${CONTRACT}"`);
    expect(html).toContain(REF);
    expect(html).not.toContain("event window");
  });

  it("shows a published heading's label instead of its id", () => {
    const html = render([CONFIRMED], 0, new Map([["h4", "Escrow contract"]]));
    expect(html).toContain("Escrow contract");
  });

  it("links a mainnet ref's approval and contract to stellar.expert's public network", () => {
    const ref = REF.replace("qdit:testnet:", "qdit:mainnet:");
    const html = render([{ ...CONFIRMED, record: { ...CONFIRMED.record, artifactRef: ref }, ref: parseQditArtifactRef(ref) }]);
    expect(html).toContain(`href="https://stellar.expert/explorer/public/tx/${APPROVAL_TX}"`);
    expect(html).toContain(`href="https://stellar.expert/explorer/public/contract/${CONTRACT}"`);
    expect(html).toContain("contract on Mainnet");
  });

  it("falls back to the contract's page when no approval transaction is on record", () => {
    const html = render([{ ...CONFIRMED, approvalTxHash: null }]);
    expect(html).toContain('data-testid="approval-unrecorded"');
    expect(html).toContain("Doqtri has no record of the approval transaction: it may be older than Stellar RPC&#x27;s event window");
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/contract/${CONTRACT}"`);
    expect(html).not.toContain("Approval transaction →");
  });

  it("names a later approval's version beside the version that was signed", () => {
    const ref = REF.replace("@v2", "@v1");
    const html = render([{ ...CONFIRMED, record: { ...CONFIRMED.record, artifactRef: ref }, ref: parseQditArtifactRef(ref) }]);
    expect(html).toContain("at v2 (signed against v1)");
  });

  it("confirmed short of approval: matches the chain, and claims no approval", () => {
    const html = render([
      {
        ...CONFIRMED,
        record: { ...CONFIRMED.record, status: "Built" },
        check: { state: "confirmed", chain: { status: "Submitted", version: 2 }, ledger: 10 },
        approvalTxHash: null,
      },
    ]);
    expect(html).toContain("Matches the chain");
    expect(html).not.toContain("Approved on chain");
    expect(html).not.toContain("Approval transaction");
    expect(html).not.toContain("approval-unrecorded");
  });

  it("differs: shows both sides and never claims approval", () => {
    const html = render([
      { ...CONFIRMED, check: { state: "differs", chain: { status: "Submitted", version: 3 }, ledger: 10 }, approvalTxHash: null },
    ]);
    expect(html).toContain('data-state="differs"');
    expect(html).toContain("Differs from the chain");
    expect(html).toContain("Submitted</strong> at v3");
    expect(html).toContain("Verified");
    expect(html).toContain("this heading is not shown as approved");
    expect(html).not.toContain("Approved on chain");
    expect(html).not.toContain("Approval transaction");
  });

  it("differs: no record on chain at all", () => {
    const html = render([{ ...CONFIRMED, check: { state: "differs", chain: null, ledger: 10 }, approvalTxHash: null }]);
    expect(html).toContain("has no record of this milestone");
    expect(html).toContain("This heading is not shown as approved.");
    expect(html).not.toContain("Approved on chain");
  });

  it("unreachable: says it could not check, for each reason", () => {
    const rpc = render([{ ...CONFIRMED, check: { state: "unreachable", reason: "rpc" }, approvalTxHash: null }]);
    expect(rpc).toContain('data-state="unreachable"');
    expect(rpc).toContain("Not checked");
    expect(rpc).toContain("could not be read just now");
    expect(rpc).not.toContain("Approved on chain");
    expect(rpc).not.toContain("Approval transaction");

    const contract = render([{ ...CONFIRMED, check: { state: "unreachable", reason: "contract" }, approvalTxHash: null }]);
    expect(contract).toContain("could not be read as qdit&#x27;s milestone_proof");

    const bad = "qdit:testnet:not-a-ref";
    const invalid = render([
      { ...CONFIRMED, record: { status: "Verified", artifactRef: bad }, ref: null, check: { state: "unreachable", reason: "invalid_ref" }, approvalTxHash: null },
    ]);
    expect(invalid).toContain("does not follow the qdit grammar");
    expect(invalid).toContain(bad);
    expect(invalid).not.toContain("/contract/");
  });

  it("says when the signing transaction is not in the history read", () => {
    const html = render([{ ...CONFIRMED, signing: null }]);
    expect(html).toContain("its transaction was not in the history read just now");
    expect(html).not.toContain("signing transaction →");
  });

  it("counts headings beyond the cap", () => {
    expect(render([CONFIRMED], 3)).toContain("3 more headings were signed from qdit and are not checked here");
    expect(render([CONFIRMED], 1)).toContain("1 more heading was signed from qdit and is not checked here");
    expect(render([CONFIRMED], 0)).not.toContain("receipts-more");
  });
});
