import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QditReceiptsSection } from "@/components/audit/qdit-receipts";
import { parseQditArtifactRef, type MilestoneChainStatus } from "@/lib/integrations/qdit-chain";
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

/** Fact 2, as the G2 fixture's m2 record holds it, at a real ledger time. */
const PROOF_HASH = "02".repeat(32);
const SUBMITTER = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
const SUBMITTED_AT = 1_761_393_600; // 2025-10-25 12:00 UTC
const onChain = (status: MilestoneChainStatus, version: number) => ({
  status,
  version,
  proofHash: PROOF_HASH,
  submitter: SUBMITTER,
  timestamp: SUBMITTED_AT,
});

const CONFIRMED: QditReceipt = {
  nodeId: "h4",
  record: { status: "Verified", artifactRef: REF, updatedAt: 1_792_843_200 },
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
  check: { state: "confirmed", chain: onChain("Approved", 2), ledger: 1234567 },
  approvalTxHash: APPROVAL_TX,
  approvalLedger: 1234000,
  qditPageUrl: null,
};

/** CONFIRMED, re-signed against another version of the same milestone. */
const signedAt = (version: number): Pick<QditReceipt, "record" | "ref"> => {
  const ref = REF.replace("@v2", `@v${version}`);
  return { record: { ...CONFIRMED.record, artifactRef: ref }, ref: parseQditArtifactRef(ref) };
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

  it("chain ahead of a Verified record: a newer submission, never shown as approved", () => {
    // Signed Verified against v1; v1 was rejected and v2 approved since.
    const html = render([
      { ...CONFIRMED, ...signedAt(1), check: { state: "differs", chain: onChain("Approved", 2), ledger: 10 } },
    ]);
    expect(html).toContain('data-state="differs"');
    expect(html).toContain("Newer submission");
    expect(html).toContain('data-testid="receipt-newer"');
    expect(html).toContain("Signed as Verified; the chain now says <strong");
    expect(html).toContain("Approved</strong> at v2");
    expect(html).toContain("a newer submission than v1, the version this heading&#x27;s signature refers to");
    expect(html).toContain("This heading is not shown as approved.");
    expect(html).not.toContain("Approved on chain");
    expect(html).not.toContain("Matches the chain");
    // The approval link is v2's, and says so.
    expect(html).toContain("Approval transaction of v2 →");
    expect(html).not.toContain("Approval transaction →");
  });

  it("chain ahead with no approval on record: the fallback names the version too", () => {
    const html = render([
      {
        ...CONFIRMED,
        ...signedAt(1),
        check: { state: "differs", chain: onChain("Approved", 2), ledger: 10 },
        approvalTxHash: null,
      },
    ]);
    expect(html).toContain("Doqtri has no record of the approval transaction of v2");
  });

  it("confirmed short of approval: matches the chain, and claims no approval", () => {
    const html = render([
      {
        ...CONFIRMED,
        record: { ...CONFIRMED.record, status: "Built" },
        check: { state: "confirmed", chain: onChain("Submitted", 2), ledger: 10 },
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
      { ...CONFIRMED, check: { state: "differs", chain: onChain("Submitted", 2), ledger: 10 }, approvalTxHash: null },
    ]);
    expect(html).toContain('data-state="differs"');
    expect(html).toContain("Differs from the chain");
    expect(html).toContain("Submitted</strong> at v2");
    expect(html).toContain("Verified");
    expect(html).toContain("this heading is not shown as approved");
    expect(html).not.toContain("Approved on chain");
    expect(html).not.toContain("Approval transaction");
  });

  it("differs at the signed version: signed as Verified, the chain now says otherwise", () => {
    const html = render([
      { ...CONFIRMED, check: { state: "differs", chain: onChain("Rejected", 2), ledger: 10 }, approvalTxHash: null },
    ]);
    expect(html).toContain("Differs from the chain");
    expect(html).toContain("Signed as Verified; the chain now says <strong");
    expect(html).toContain("Rejected</strong> at v2");
  });

  it("chain behind the signed version: unverified, naming the mismatch", () => {
    const html = render([
      { ...CONFIRMED, ...signedAt(3), check: { state: "differs", chain: onChain("Submitted", 1), ledger: 10 }, approvalTxHash: null },
    ]);
    expect(html).toContain("Unverified</span>");
    expect(html).toContain('data-testid="receipt-mismatch"');
    expect(html).toContain("holds v1 (Submitted)");
    expect(html).toContain("older than v3, the version this heading was signed against, so it cannot be checked");
    expect(html).toContain("This heading is not shown as approved.");
    expect(html).not.toContain("Differs from the chain");

    const built = render([
      {
        ...CONFIRMED,
        ...signedAt(3),
        record: { ...signedAt(3).record, status: "Built" },
        check: { state: "differs", chain: onChain("Submitted", 1), ledger: 10 },
        approvalTxHash: null,
      },
    ]);
    expect(built).toContain("older than v3, the version this heading was signed against");
    expect(built).not.toContain("not shown as approved");
  });

  it("no record on chain at all: unverified whatever the record's status", () => {
    const verified = render([{ ...CONFIRMED, check: { state: "differs", chain: null, ledger: 10 }, approvalTxHash: null }]);
    expect(verified).toContain("Unverified</span>");
    expect(verified).toContain("has no record of this milestone");
    expect(verified).toContain("though this heading was signed against v2, so it cannot be checked");
    expect(verified).toContain("This heading is not shown as approved.");
    expect(verified).not.toContain("Approved on chain");

    const building = render([
      {
        ...CONFIRMED,
        record: { ...CONFIRMED.record, status: "Building" },
        check: { state: "differs", chain: null, ledger: 10 },
        approvalTxHash: null,
      },
    ]);
    expect(building).toContain("Unverified</span>");
    expect(building).toContain('data-testid="receipt-mismatch"');
    expect(building).toContain("though this heading was signed against v2, so it cannot be checked");
  });

  it("a ref that does not match the note's linked project: unverified, one wording for every mismatch", () => {
    const html = (mismatch: "unlinked" | "project" | "no_chain" | "chain", status = "Verified") =>
      render([
        {
          ...CONFIRMED,
          record: { ...CONFIRMED.record, status },
          check: { state: "differs", mismatch },
          approvalTxHash: null,
        },
      ]);
    const chain = html("chain");
    expect(chain).toContain('data-state="differs"');
    expect(chain).toContain("Unverified</span>");
    expect(chain).toContain('data-testid="receipt-link-mismatch"');
    expect(chain).toContain(
      "this record does not match a qdit project and contract registered in Doqtri for this note, so the contract it names was not read",
    );
    expect(chain).toContain("This heading is not shown as approved.");
    expect(chain).not.toContain("Approved on chain");
    expect(chain).not.toContain("Matches the chain");
    expect(chain).not.toContain("Approval transaction");
    expect(chain).not.toContain("approval-unrecorded");
    expect(chain).not.toContain("as of ledger");
    expect(chain).not.toContain("receipt-submission");
    // The link row's values never show, and every mismatch reads alike.
    for (const mismatch of ["unlinked", "project", "no_chain"] as const) expect(html(mismatch)).toBe(chain);
    expect(html("chain", "Built")).not.toContain("not shown as approved");
  });

  it("shows fact 2 in full: the submission's version, proof hash, submitter and time", () => {
    const html = render([CONFIRMED]);
    expect(html).toContain('data-testid="receipt-submission"');
    expect(html).toContain("Submission v2");
    expect(html).toContain(PROOF_HASH);
    // The submitter on the ref's network: a contract address gets a contract page.
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/contract/${SUBMITTER}"`);
    expect(html).toContain(`title="${SUBMITTER}"`);
    expect(html).toContain("· at 2025-10-25 12:00 UTC");

    const mainnetRef = REF.replace("qdit:testnet:", "qdit:mainnet:");
    const account = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
    const mainnet = render([
      {
        ...CONFIRMED,
        record: { ...CONFIRMED.record, artifactRef: mainnetRef },
        ref: parseQditArtifactRef(mainnetRef),
        check: { state: "confirmed", chain: { ...onChain("Approved", 2), submitter: account }, ledger: 10 },
      },
    ]);
    expect(mainnet).toContain(`href="https://stellar.expert/explorer/public/account/${account}"`);

    // The test host's ledger time 0 is not shown as 1970.
    const untimed = render([{ ...CONFIRMED, check: { state: "confirmed", chain: { ...onChain("Approved", 2), timestamp: 0 }, ledger: 10 } }]);
    expect(untimed).toContain(PROOF_HASH);
    expect(untimed).not.toContain("1970");
  });

  it("shows the submission the chain holds whether it is newer, older or other than the signed one", () => {
    const newer = render([{ ...CONFIRMED, ...signedAt(1), check: { state: "differs", chain: onChain("Approved", 2), ledger: 10 } }]);
    expect(newer).toContain("Submission v2");
    expect(newer).toContain(PROOF_HASH);
    const older = render([{ ...CONFIRMED, ...signedAt(3), check: { state: "differs", chain: onChain("Submitted", 1), ledger: 10 }, approvalTxHash: null }]);
    expect(older).toContain("Submission v1");
    const rejected = render([{ ...CONFIRMED, check: { state: "differs", chain: onChain("Rejected", 2), ledger: 10 }, approvalTxHash: null }]);
    expect(rejected).toContain("Submission v2");
    // Nothing read, nothing shown.
    for (const check of [
      { state: "differs", chain: null, ledger: 10 },
      { state: "unreachable", reason: "rpc" },
    ] as const) {
      expect(render([{ ...CONFIRMED, check, approvalTxHash: null }])).not.toContain("receipt-submission");
    }
  });

  it("links qdit's milestone page only when the loader confirmed qdit publishes it", () => {
    expect(render([CONFIRMED])).not.toContain('data-testid="qdit-page"');
    const url = "https://qdit.example/p/soroban-payroll/c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72";
    const html = render([{ ...CONFIRMED, qditPageUrl: url }]);
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain("milestone on qdit →");
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

    const link = render([{ ...CONFIRMED, check: { state: "unreachable", reason: "link" }, approvalTxHash: null }]);
    expect(link).toContain("Not checked");
    expect(link).toContain("Doqtri could not read its own records just now");
    expect(link).not.toContain("Approved on chain");

    const bad = "qdit:testnet:not-a-ref";
    const invalid = render([
      { ...CONFIRMED, record: { status: "Verified", artifactRef: bad, updatedAt: null }, ref: null, check: { state: "unreachable", reason: "invalid_ref" }, approvalTxHash: null },
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
