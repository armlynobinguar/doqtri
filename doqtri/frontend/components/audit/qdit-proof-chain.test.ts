import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QditReceiptsSection } from "@/components/audit/qdit-receipts";
import { parseQditArtifactRef, type MilestoneChainStatus } from "@/lib/integrations/qdit-chain";
import type { PlanContext } from "@/lib/integrations/qdit-proof-chain";
import type { QditReceipt, ReceiptCheck } from "@/lib/integrations/qdit-receipts";
import type { SignerRemoval } from "@/lib/stellar/signers";
import type { DocumentHistory } from "@/lib/stellar/history";

/*
 * What the chain view under a qdit receipt renders for each step in each
 * state (WP-3.3, CONTRACT.md section 12). Static markup, as for the
 * receipts: the unit tests run in Node without a DOM.
 */

const DOC = "30000000-0000-4000-8000-000000000001";
const CONTRACT = "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG";
const PROJECT = "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34";
const MILESTONE = "c92f5018-7b3d-4ea4-9f60-1d8b0c4e3f72";
const REF = (v: number) => `qdit:testnet:${CONTRACT}:${PROJECT}/${MILESTONE}@v${v}`;
const SIGNER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const TX = (n: number) => n.toString(16).padStart(64, "0");
const HASH = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const SUBMITTED_AT = 1_761_393_600; // 2025-10-25 12:00 UTC

const onChain = (status: MilestoneChainStatus, version: number) => ({
  status,
  version,
  proofHash: "02".repeat(32),
  submitter: SIGNER,
  timestamp: SUBMITTED_AT,
});

function receipt(overrides: Partial<QditReceipt> & { v?: number; status?: string } = {}): QditReceipt {
  const { v = 2, status = "Verified", ...rest } = overrides;
  return {
    nodeId: "h4",
    record: { status, artifactRef: REF(v), updatedAt: 1_792_800_000 },
    ref: parseQditArtifactRef(REF(v)),
    signing: {
      nodeId: "h4",
      status,
      tool: "qdit",
      artifactRef: REF(v),
      txHash: TX(20),
      closedAt: "2026-10-24T12:00:00Z",
      docVersion: 2,
      signer: SIGNER,
      signerFrom: "call",
    },
    check: { state: "confirmed", chain: onChain("Approved", v), ledger: 5000 },
    approvalTxHash: TX(30),
    approvalLedger: 4990,
    qditPageUrl: null,
    ...rest,
  };
}

const HISTORY: DocumentHistory = {
  owner: SIGNER,
  versions: [1, 2, 3].map((version) => ({
    version,
    contentHash: HASH(version),
    txHash: TX(version),
    closedAt: `2026-10-2${version}T10:00:00Z`,
    signer: SIGNER,
    signerFrom: "call" as const,
  })),
  nodeEvents: [],
  nodes: [],
};

const PLAN: PlanContext = {
  doc: { version: 3, nodeCount: 5, contentHash: HASH(3), updatedAt: 1_792_843_200, owner: SIGNER },
  history: HISTORY,
};

const render = (r: QditReceipt, plan: PlanContext | null = PLAN, removals: SignerRemoval[] = []) =>
  renderToStaticMarkup(
    createElement(QditReceiptsSection, {
      receipts: { receipts: [r], more: 0 },
      labels: null,
      chain: plan ? { docId: DOC, removals, ...plan } : undefined,
    }),
  );

const checkYourself = (html: string) => html.match(/<p data-testid="chain-check-yourself"[\s\S]*?<\/p>/)![0];

/** One step's `<li>`, by its key. */
function step(html: string, key: "plan" | "submitted" | "approved" | "verified"): string {
  const match = html.match(new RegExp(`<li data-testid="chain-step-${key}"[\\s\\S]*?</li>`));
  expect(match, `step ${key}`).not.toBeNull();
  return match![0];
}

const stateOf = (li: string) => li.match(/data-state="(\w+)"/)![1];
const differs = (status: MilestoneChainStatus, version: number): ReceiptCheck => ({
  state: "differs",
  chain: onChain(status, version),
  ledger: 5000,
});

describe("ProofChainView: the list", () => {
  it("words each state as qdit's page does (D-78): Done, Pending, Does not match, Could not check", () => {
    const tags = (html: string) =>
      (["plan", "submitted", "approved", "verified"] as const).map((k) => step(html, k).match(/>(Done|Pending|Does not match|Could not check)<\/span>/)![1]);
    expect(tags(render(receipt({ check: differs("Submitted", 2) })))).toEqual(["Done", "Done", "Pending", "Does not match"]);
    expect(tags(render(receipt({ check: { state: "unreachable", reason: "rpc" } })))).toEqual([
      "Done",
      "Could not check",
      "Could not check",
      "Could not check",
    ]);
  });

  it("is an ordered list of the four steps, folded inside the receipt, each state in words", () => {
    const html = render(receipt());
    expect(html).toContain('<details data-testid="proof-chain"');
    expect(html).toContain("Full proof chain: 4 of 4 steps done");
    expect(html).toMatch(/<ol [^>]*aria-label="Proof chain, from plan version to verified"/);
    const order = ["plan", "submitted", "approved", "verified"].map((k) => html.indexOf(`chain-step-${k}`));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]))).toBe(true);
    for (const key of ["plan", "submitted", "approved", "verified"] as const) {
      expect(stateOf(step(html, key))).toBe("done");
      // The state is text, not only a coloured dot.
      expect(step(html, key)).toContain(">Done</span>");
    }
  });

  it("says how to check it yourself on Stellar Expert, with both contracts and their calls", () => {
    const html = render(receipt());
    const line = html.match(/<p data-testid="chain-check-yourself"[\s\S]*?<\/p>/)![0];
    expect(line).toContain("How to check this yourself");
    expect(line).toContain("Stellar Expert");
    expect(line).toContain("https://stellar.expert/explorer/testnet/contract/");
    expect(line).toContain(`get_document(&quot;${DOC}&quot;)`);
    expect(line).toContain(`get_node(&quot;${DOC}&quot;, &quot;h4&quot;)`);
    expect(line).toContain(`href="https://stellar.expert/explorer/testnet/contract/${CONTRACT}"`);
    expect(line).toContain(`get_milestone_status(&quot;${PROJECT}&quot;, &quot;${MILESTONE}&quot;)`);
  });

  it("is left out when the page gives no Document and history", () => {
    const html = render(receipt(), null);
    expect(html).toContain('data-testid="qdit-receipt"');
    expect(html).not.toContain("proof-chain");
  });
});

describe("ProofChainView: step 1, plan version", () => {
  it("done: the version signed at and the current one, each with its anchoring transaction", () => {
    const li = step(render(receipt()), "plan");
    expect(li).toContain("Signed at plan version <strong");
    expect(li).toContain(">v2</strong>");
    expect(li).toContain("Current plan version <strong");
    expect(li).toContain(">v3</strong>");
    expect(li).toContain(`title="${HASH(2)}"`);
    expect(li).toContain(`href="https://stellar.expert/explorer/testnet/tx/${TX(2)}"`);
    expect(li).toContain(`href="https://stellar.expert/explorer/testnet/tx/${TX(3)}"`);
    expect(li).toContain("anchored 2026-10-22 10:00 UTC");
    expect(li).toContain("The plan has been anchored again since");
  });

  it("done at the current version: one line", () => {
    const r = receipt();
    const li = step(render({ ...r, signing: { ...r.signing!, docVersion: 3 } }), "plan");
    expect(li).toContain("Signed at the current plan version");
    expect(li).not.toContain("anchored again");
  });

  it("could not check: the current version from the Document, and why the signed one is unknown", () => {
    const li = step(render(receipt(), { ...PLAN, history: null }), "plan");
    expect(stateOf(li)).toBe("unchecked");
    expect(li).toContain(">Could not check</span>");
    expect(li).toContain("Current plan version");
    expect(li).toContain("Last updated 2026-10-24 12:00 UTC.");
    expect(li).toContain("not in the history read just now");
    expect(li).not.toContain("anchoring transaction");
  });
});

describe("ProofChainView: step 2, submitted", () => {
  it("done: fact 2 in full, as of the ledger read, and the contract, since Doqtri records no submissions", () => {
    const li = step(render(receipt()), "submitted");
    expect(li).toContain(">v2</strong> submitted, now Approved as of ledger 5,000.");
    expect(li).toContain(`title="${"02".repeat(32)}"`);
    expect(li).toContain("at 2025-10-25 12:00 UTC");
    // A fact, not the RPC window: a submission minutes old is not on record either.
    expect(li).toContain("Doqtri does not record submission transactions; the <a");
    expect(li).not.toContain("event window");
    expect(li).toContain(`href="https://stellar.expert/explorer/testnet/contract/${CONTRACT}"`);
  });

  it("done with a newer submission: says the heading's version was submitted and names the newer one", () => {
    const li = step(render(receipt({ v: 1, check: differs("Approved", 2) })), "submitted");
    expect(stateOf(li)).toBe("done");
    expect(li).toContain("v1 was submitted; the chain now holds a newer submission");
    expect(li).toContain(">v2</strong> (Approved)");
  });

  it("pending: the record is still Proposed", () => {
    const li = step(render(receipt({ status: "Planned", check: differs("Proposed", 2) })), "submitted");
    expect(stateOf(li)).toBe("pending");
    expect(li).toContain(">Pending</span>");
    expect(li).toContain("holds v2 as Proposed as of ledger 5,000: not submitted yet.");
  });

  it.each([
    [{ state: "unreachable", reason: "rpc" }, "could not be read just now"],
    [{ state: "unreachable", reason: "invalid_ref" }, "does not follow the integration contract&#x27;s grammar"],
    [{ state: "unreachable", reason: "link" }, "Doqtri could not read its own records just now"],
  ] as const)("could not check: %j", (check, text) => {
    const li = step(render(receipt({ check: check as ReceiptCheck })), "submitted");
    expect(stateOf(li)).toBe("unchecked");
    expect(li).toContain(">Could not check</span>");
    expect(li).toContain(text);
  });

  it.each([
    [{ state: "differs", chain: null, ledger: 5000 }, "has no record of this milestone, though this heading was signed against v2"],
    [differs("Approved", 1), "holds v1 (Approved), older than v2"],
    // D-79, D-93: deliberately not read, which is no failed read.
    [{ state: "differs", mismatch: "project" }, "does not match a qdit project and contract registered in Doqtri"],
  ] as const)("does not match: the chain was read and has no submission at vV, or the ref is not the link's: %j", (check, text) => {
    const li = step(render(receipt({ check: check as ReceiptCheck })), "submitted");
    expect(stateOf(li)).toBe("mismatch");
    expect(li).toContain(">Does not match</span>");
    expect(li).toContain(text);
  });
});

describe("ProofChainView: step 3, approved", () => {
  it("done: approved at the signed version, with the approval transaction and its ledger", () => {
    const li = step(render(receipt()), "approved");
    expect(li).toContain(">v2</strong> approved, the version this heading was signed against.");
    expect(li).toContain(`href="https://stellar.expert/explorer/testnet/tx/${TX(30)}"`);
    expect(li).toContain("Approval transaction →");
    expect(li).toContain("(ledger 4,990)");
  });

  it("done without a recorded transaction: the contract, with the window wording", () => {
    const li = step(render(receipt({ approvalTxHash: null, approvalLedger: null })), "approved");
    expect(stateOf(li)).toBe("done");
    expect(li).toContain('data-testid="chain-no-tx"');
    expect(li).toContain("Doqtri has no record of the approval transaction");
    expect(li).toContain("event window (about 7 days), or Doqtri did not see it in time.");
    expect(li).not.toContain("does not record submission");
    expect(li).not.toContain(TX(30));
  });

  it("pending: submitted, not approved yet", () => {
    const li = step(render(receipt({ status: "Built", check: differs("Submitted", 2) })), "approved");
    expect(stateOf(li)).toBe("pending");
    expect(li).toContain("Not approved yet: the chain says Submitted at v2.");
  });

  it("pending: rejected", () => {
    const li = step(render(receipt({ status: "Building", check: differs("Rejected", 2) })), "approved");
    expect(stateOf(li)).toBe("pending");
    expect(li).toContain("Rejected at v2: not approved.");
  });

  it("fixture M2: done for the current record after a resubmission, naming the heading's version (D-78)", () => {
    // Signed Built @v1; v1 rejected, v2 approved. qdit's page says "v2 approved" too.
    const li = step(render(receipt({ v: 1, status: "Built", check: differs("Approved", 2) })), "approved");
    expect(stateOf(li)).toBe("done");
    expect(li).toContain(">Done</span>");
    expect(li).toMatch(/>v2<\/strong> approved; the heading was signed for v1\./);
    expect(li).toContain("Approval transaction of v2 →");
  });

  it("pending after a resubmission not yet decided, naming the heading's version", () => {
    const li = step(render(receipt({ v: 1, status: "Built", check: differs("Submitted", 2) })), "approved");
    expect(stateOf(li)).toBe("pending");
    expect(li).toContain("Not approved yet: the chain says Submitted at v2; the heading was signed for v1.");
  });

  it("pending when the chain has no record: nothing is approved", () => {
    const li = step(render(receipt({ check: { state: "differs", chain: null, ledger: 5000 } })), "approved");
    expect(stateOf(li)).toBe("pending");
    expect(li).toContain("has no record of this milestone, so nothing is approved.");
  });

  it("could not check when the submission could not", () => {
    const li = step(render(receipt({ check: { state: "unreachable", reason: "rpc" } })), "approved");
    expect(stateOf(li)).toBe("unchecked");
    expect(li).toContain("Not checked");
    expect(li).not.toMatch(/approval transaction/i);
  });
});

describe("ProofChainView: step 4, verified", () => {
  it("done: signed Verified with tool qdit, its signer, time and transaction", () => {
    const li = step(render(receipt()), "verified");
    expect(li).toContain("Signed <strong");
    expect(li).toContain("with tool &quot;qdit&quot;, against the approved v2.");
    expect(li).toContain(`title="${SIGNER}"`);
    expect(li).toContain("· recorded 2026-10-24 00:00 UTC");
    expect(li).toContain(`href="https://stellar.expert/explorer/testnet/tx/${TX(20)}"`);
  });

  it("pending: approved on chain, not yet signed Verified in Doqtri", () => {
    const li = step(render(receipt({ status: "Built", check: differs("Approved", 2) })), "verified");
    expect(stateOf(li)).toBe("pending");
    expect(li).toContain("qdit approved v2; Doqtri&#x27;s record still says Built, not yet signed Verified.");
  });

  it("pending: not approved and not signed Verified", () => {
    const li = step(render(receipt({ status: "Built", check: differs("Submitted", 2) })), "verified");
    expect(stateOf(li)).toBe("pending");
    expect(li).toContain("Doqtri&#x27;s record says Built: not signed Verified.");
  });

  it("fixture M3: does not match when signed Verified but the chain says Submitted, never shown as verified", () => {
    const li = step(render(receipt({ check: differs("Submitted", 2) })), "verified");
    expect(stateOf(li)).toBe("mismatch");
    expect(li).toContain(">Does not match</span>");
    expect(li).not.toContain("Could not check");
    expect(li).toContain(
      "Signed as Verified for v2; the chain now says Submitted at v2, so this heading is not shown as verified.",
    );
  });

  it("does not match after a resubmission was approved: the signature is for v1", () => {
    const html = render(receipt({ v: 1, check: differs("Approved", 2) }));
    const li = step(html, "verified");
    expect(stateOf(li)).toBe("mismatch");
    expect(li).toContain("Signed as Verified for v1; the chain now says Approved at v2");
    expect(html).toContain("Full proof chain: 3 of 4 steps done");
  });

  it("does not match when the chain has no record of the milestone", () => {
    const li = step(render(receipt({ check: { state: "differs", chain: null, ledger: 5000 } })), "verified");
    expect(stateOf(li)).toBe("mismatch");
    expect(li).toContain("Signed as Verified for v2; qdit&#x27;s contract has no record of this milestone");
  });

  it("does not match when the ref is not the note's linked project's, worded the same for every mismatch", () => {
    const texts = (["unlinked", "project", "no_chain", "chain"] as const).map((mismatch) =>
      step(render(receipt({ check: { state: "differs", mismatch } })), "verified"),
    );
    for (const li of texts) {
      expect(stateOf(li)).toBe("mismatch");
      expect(li).toContain("does not match a qdit project and contract registered in Doqtri for this note");
    }
    expect(new Set(texts).size).toBe(1);
  });

  it("pending after a resubmission was approved: names the version the record was signed for", () => {
    const li = step(render(receipt({ v: 1, status: "Built", check: differs("Approved", 2) })), "verified");
    expect(stateOf(li)).toBe("pending");
    expect(li).toContain("qdit approved v2; Doqtri&#x27;s record still says Built for v1, not yet signed Verified.");
  });

  it("could not check: signed Verified and the chain could not be read", () => {
    const html = render(receipt({ check: { state: "unreachable", reason: "rpc" } }));
    const li = step(html, "verified");
    expect(stateOf(li)).toBe("unchecked");
    expect(li).toContain("the approval above could not be checked");
    expect(html).toContain("Full proof chain: 1 of 4 steps done");
  });

  it("flags a signature made after Doqtri removed the wallet (D-16), as the version history does", () => {
    const removed: SignerRemoval = { address: SIGNER, removedAt: "2026-10-23T08:00:00Z", restoredAt: null, revokedAt: null };
    const li = step(render(receipt(), PLAN, [removed]), "verified");
    expect(li).toContain('data-testid="chain-signed-after-removal"');
    expect(li).toContain("Signed after removal");
    expect(li).toContain("removed this wallet from the note&#x27;s workspace 2026-10-23 08:00 UTC");
    // Removed after signing, or restored before it: no flag.
    for (const r of [
      { ...removed, removedAt: "2026-10-25T08:00:00Z" },
      { ...removed, restoredAt: "2026-10-24T08:00:00Z" },
      { ...removed, address: "GOTHER" },
    ]) {
      expect(step(render(receipt(), PLAN, [r]), "verified")).not.toContain("Signed after removal");
    }
  });

  it("names the role when an owner-only signing write's wallet could not be read, as the version history does", () => {
    const r = receipt();
    const li = step(render({ ...r, signing: { ...r.signing!, signer: null, signerFrom: "owner" } }), "verified");
    expect(li).toContain('data-testid="chain-signer-owner-at-time"');
    expect(li).toContain("Signed by the note&#x27;s owner at the time");
    expect(li).not.toContain(`title="${SIGNER}"`);
    expect(li).not.toContain("Signed after removal");
    // Still the signing transaction.
    expect(li).toContain(`href="https://stellar.expert/explorer/testnet/tx/${TX(20)}"`);
  });

  it("names the missing transaction when the history did not have the signing write", () => {
    const li = step(render(receipt({ signing: null })), "verified");
    expect(li).toContain("its transaction was not in the history read just now");
  });
});

describe("ProofChainView: a ref not checked against the linked project", () => {
  it("a ref deliberately not read: steps 1 to 3 say Does not match, never Could not check (D-93)", () => {
    const html = render(receipt({ check: { state: "differs", mismatch: "chain" } }));
    for (const key of ["plan", "submitted", "approved", "verified"] as const) {
      const li = step(html, key);
      expect(stateOf(li)).toBe("mismatch");
      expect(li).toContain(">Does not match</span>");
    }
    expect(html).not.toContain("Could not check");
    expect(html).not.toContain("Not checked");
    // Step 1 still shows the registry's versions, and says why they are not tied to the milestone.
    const plan = step(html, "plan");
    expect(plan).toContain(">v2</strong>");
    expect(plan).toContain("does not match a qdit project and contract registered in Doqtri for this note");
    expect(step(html, "approved")).toContain("does not match this note&#x27;s qdit project, so nothing is shown as approved");
    expect(step(html, "verified")).toContain("Signed as Verified, but this record does not match");
    // Nothing links the contract the ref names (D-94); only DoqtriRegistry is linked.
    expect(html).not.toContain(`/contract/${CONTRACT}`);
    expect(html).not.toContain("get_milestone_status");
  });


  it.each([
    ["does not match it", { state: "differs", mismatch: "chain" }],
    ["could not be compared: Doqtri's link rows were unreadable", { state: "unreachable", reason: "link" }],
    ["does not parse", { state: "unreachable", reason: "invalid_ref" }],
  ] as const)("does not offer the contract it names as qdit's when it %s", (_, check) => {
    const r = receipt({ check: check as ReceiptCheck });
    const invalid = check.state === "unreachable" && check.reason === "invalid_ref";
    const line = checkYourself(render(invalid ? { ...r, ref: null } : r));
    expect(line).not.toContain("milestone_proof");
    expect(line).not.toContain("get_milestone_status");
    expect(line).not.toContain(CONTRACT);
    expect(line).toContain("DoqtriRegistry contract");
  });

  it.each(["rpc", "contract"] as const)("still offers it when the ref matched but the read failed (%s)", (reason) => {
    const line = checkYourself(render(receipt({ check: { state: "unreachable", reason } })));
    expect(line).toContain(`href="https://stellar.expert/explorer/testnet/contract/${CONTRACT}"`);
    expect(line).toContain("qdit&#x27;s milestone_proof contract");
  });
});
