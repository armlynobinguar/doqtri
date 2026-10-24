import { describe, expect, it } from "vitest";
import { planQditSignature, suggestQditStatus, type QditMilestoneStateRow } from "@/lib/integrations/qdit-status";
import { buildMindmap } from "@/lib/mindmap";
import type { QditLinkRow } from "@/lib/node-links";

/*
 * What the ship panel suggests for a heading linked to a qdit milestone
 * (WP-2.8): from the chain only (D-04), mapped by D-19, signed with
 * tool = "qdit" and the section 10 artifact_ref.
 */

const PROJECT = "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34";
const MILESTONE = "b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61";
const CONTRACT = "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG";
const REF = `qdit:testnet:${CONTRACT}:${PROJECT}/${MILESTONE}@v2`;

const link = { qdit_state: "linked" as const, qdit_project_id: PROJECT, qdit_milestone_id: MILESTONE, node_id: "h4" };

function state(overrides: Partial<QditMilestoneStateRow> = {}): QditMilestoneStateRow {
  return {
    milestone_id: MILESTONE,
    project_id: PROJECT,
    qdit_status: "approved",
    qdit_status_at: "2026-10-24T12:00:00Z",
    chain_status: "Approved",
    chain_network: "testnet",
    chain_contract_id: CONTRACT,
    chain_version: 2,
    chain_ledger: 900,
    chain_checked_at: "2026-10-24T12:00:01Z",
    qdit_checked_at: null,
    ...overrides,
  };
}

describe("suggestQditStatus", () => {
  it("suggests Verified for a milestone approved on chain (G2)", () => {
    expect(suggestQditStatus({ link, state: state(), record: null })).toEqual({
      kind: "sign",
      update: { nodeId: "h4", status: "Verified", tool: "qdit", artifactRef: REF },
      reason: "Approved on Stellar (v2).",
      preview: null,
    });
  });

  it("maps every chain status by D-19", () => {
    const status = (chain_status: QditMilestoneStateRow["chain_status"]) => {
      const s = suggestQditStatus({ link, state: state({ chain_status, qdit_status: null, qdit_status_at: null }), record: null });
      return s.kind === "sign" ? s.update.status : s.status;
    };
    expect(status("Submitted")).toBe("Built");
    expect(status("Approved")).toBe("Verified");
    expect(status("Rejected")).toBe("Building");
    expect(status("Proposed")).toBe("Planned");
  });

  it("is up to date when the heading's record already says exactly that", () => {
    const s = suggestQditStatus({ link, state: state(), record: { status: "Verified", tool: "qdit", artifactRef: REF } });
    expect(s).toMatchObject({ kind: "current", status: "Verified" });
  });

  it("signs again for a new submission, or over a record from another tool", () => {
    const resubmitted = suggestQditStatus({
      link,
      state: state({ chain_status: "Submitted", chain_version: 3, qdit_status: "submitted" }),
      record: { status: "Built", tool: "qdit", artifactRef: REF },
    });
    expect(resubmitted).toMatchObject({ kind: "sign", update: { status: "Built", artifactRef: REF.replace("@v2", "@v3") } });
    const manual = suggestQditStatus({ link, state: state(), record: { status: "Verified", tool: "manual", artifactRef: "" } });
    expect(manual.kind).toBe("sign");
  });

  it("follows a rejection back down to Building", () => {
    const s = suggestQditStatus({
      link,
      state: state({ chain_status: "Rejected", qdit_status: "rejected" }),
      record: { status: "Built", tool: "qdit", artifactRef: REF },
    });
    expect(s).toMatchObject({ kind: "sign", update: { status: "Building" } });
  });

  it("suggests nothing from qdit's word alone: approved in qdit, still submitted on chain", () => {
    const s = suggestQditStatus({
      link,
      state: state({ chain_status: "Submitted" }),
      record: { status: "Built", tool: "qdit", artifactRef: REF },
    });
    expect(s).toMatchObject({ kind: "current", status: "Built", preview: "qdit says approved; Stellar doesn't show that yet." });
  });

  it("never signs a milestone with no record, or a project not on chain", () => {
    expect(suggestQditStatus({ link, state: state({ chain_status: "none", chain_version: null }), record: null })).toMatchObject({
      kind: "none",
      status: "Planned",
    });
    expect(
      suggestQditStatus({
        link,
        state: state({ chain_status: "unregistered", chain_network: null, chain_contract_id: null, chain_version: null }),
        record: null,
      }),
    ).toMatchObject({ kind: "none", status: "Planned" });
  });

  it("waits for a chain read, and for a broken link to be fixed", () => {
    expect(suggestQditStatus({ link, state: null, record: null })).toMatchObject({ kind: "none", status: null });
    expect(suggestQditStatus({ link, state: state({ chain_status: null }), record: null }).kind).toBe("none");
    for (const qdit_state of ["ambiguous", "broken", "conflict"] as const) {
      expect(suggestQditStatus({ link: { ...link, qdit_state }, state: state(), record: null }).kind).toBe("none");
    }
    // A heading that moved is already at its new id here; only qdit is behind.
    expect(suggestQditStatus({ link: { ...link, qdit_state: "pending" }, state: state(), record: null }).kind).toBe("sign");
  });

  it("refuses to name a record a verifier could not parse", () => {
    const s = suggestQditStatus({ link: { ...link, qdit_project_id: PROJECT.toUpperCase() }, state: state(), record: null });
    expect(s.kind).toBe("none");
  });
});

describe("suggestQditStatus with a failed record read", () => {
  it("suggests nothing rather than treating the failure as no record", () => {
    const s = suggestQditStatus({ link, state: state(), record: null, recordUnread: true });
    expect(s).toMatchObject({ kind: "none", status: null });
  });
});

describe("planQditSignature", () => {
  // root ("Mark mindmap done": Verified, signed by hand)
  //   h0 Plan
  //     h1 Escrow (qdit, M approved)
  //     h2 Payroll (Verified by hand)
  const tree = buildMindmap("Doc", "# Plan\n## Escrow\n## Payroll");
  const row: QditLinkRow = {
    id: "row-1",
    node_id: "h1",
    node_label: "Escrow",
    qdit_project_id: PROJECT,
    qdit_milestone_id: MILESTONE,
    qdit_link_id: "l1",
    qdit_url: null,
    qdit_doc_version: null,
    qdit_state: "linked",
  };
  const records = {
    root: { status: "Verified", tool: "doqtri-done", artifactRef: "v1" },
    h0: null,
    h1: null,
    h2: { status: "Verified", tool: "manual", artifactRef: "" },
  };
  const base = {
    tree,
    rows: [row],
    linkIds: ["row-1"],
    states: { [MILESTONE]: state() },
    records,
    unreadNodes: [] as string[],
    unreadMilestones: [] as string[],
    otherLinked: [] as string[],
  };

  it("signs the heading and the parent it rolls up, leaving the hand-signed root alone", () => {
    const plan = planQditSignature(base);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.updates).toEqual([{ nodeId: "h1", status: "Verified", tool: "qdit", artifactRef: REF }]);
    expect(plan.rollups.map((u) => [u.nodeId, u.status])).toEqual([["h0", "Verified"]]);
    expect(plan.batches).toHaveLength(1);
  });

  it("refuses when a heading's record could not be read (the root's attestation would be overwritten)", () => {
    const { root: _root, ...rest } = records;
    void _root;
    const plan = planQditSignature({ ...base, records: rest, unreadNodes: ["root"] });
    expect(plan).toMatchObject({ ok: false, reason: "unread" });
  });

  it("refuses when the forced chain read of a picked milestone failed", () => {
    expect(planQditSignature({ ...base, unreadMilestones: [MILESTONE] })).toMatchObject({ ok: false, reason: "unread" });
    // Another milestone's failure does not hold this one up.
    expect(planQditSignature({ ...base, unreadMilestones: ["c81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61"] }).ok).toBe(true);
  });

  it("says so when there is nothing to sign", () => {
    const signed = { ...records, h1: { status: "Verified", tool: "qdit", artifactRef: REF } };
    expect(planQditSignature({ ...base, records: signed })).toMatchObject({ ok: false, reason: "nothing" });
  });
});
