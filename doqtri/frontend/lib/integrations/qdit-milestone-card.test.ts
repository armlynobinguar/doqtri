import { describe, expect, it } from "vitest";
import {
  anchorLabel,
  anchorTxUrl,
  cardStateFromResponse,
  formatDueDate,
  NODE_STATUS_FOR,
  safeHttpUrl,
  toMilestonePreview,
} from "@/lib/integrations/qdit-milestone-card";

/*
 * The milestone card's rules (WP-2.6): what it keeps of qdit's Milestone,
 * which state each route answer puts it in, and the D-19 mapping.
 */

/** CONTRACT.md section 7's Milestone example. */
const MILESTONE = {
  id: "b81e4f07-6a2c-4d93-8e5f-0c7a9b3d2e61",
  project: { id: "3f6c2a1e-8b4d-4c7e-9a10-2d5b7e9f1c34", name: "Soroban payroll", slug: "soroban-payroll" },
  title: "Escrow contract",
  description: null,
  status: "submitted",
  due_date: "2026-11-15",
  order_index: 3,
  url: "https://qdit.atalusan.com/projects/soroban-payroll/milestones",
  link: {
    id: "0e9d4c3b-2a1f-4e5d-8c7b-6a5f4e3d2c1b",
    doc_id: "c2d1e0f9-8a7b-4c6d-9e5f-4a3b2c1d0e9f",
    node_id: "h4",
    node_label: "Escrow contract",
    doc_version: 7,
    created_at: "2026-10-20T14:02:11.000Z",
    updated_at: "2026-10-20T14:02:11.000Z",
  },
  anchor: {
    network: "testnet",
    contract_id: "CBP3NKXCRUSOJLLUXDF5AIRNPAC6IL7TFJ2KCNL5A2GTKC2MB7M4OHVG",
    version: 2,
    proof_hash: "9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab",
    last_action: "submit",
    last_tx_hash: "5e1f0c3a9b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a3c5e7b9d0f",
    anchored_at: "2026-10-22T08:11:40.000Z",
  },
  created_at: "2026-10-20T14:02:11.000Z",
  updated_at: "2026-10-22T08:11:40.000Z",
};

describe("toMilestonePreview", () => {
  it("keeps the fields the card shows, from the contract's example", () => {
    expect(toMilestonePreview(MILESTONE)).toEqual({
      id: MILESTONE.id,
      title: "Escrow contract",
      status: "submitted",
      due_date: "2026-11-15",
      url: "https://qdit.atalusan.com/projects/soroban-payroll/milestones",
      project: MILESTONE.project,
      node: { id: "h4", label: "Escrow contract" },
      anchor: {
        network: "testnet",
        version: 2,
        last_action: "submit",
        last_tx_hash: MILESTONE.anchor.last_tx_hash,
        anchored_at: "2026-10-22T08:11:40.000Z",
      },
      updated_at: "2026-10-22T08:11:40.000Z",
    });
  });

  it("drops unknown and unshown fields (section 3)", () => {
    const preview = toMilestonePreview({ ...MILESTONE, secret_field: "x", project: { ...MILESTONE.project, extra: 1 } });
    expect(JSON.stringify(preview)).not.toContain("secret_field");
    expect(JSON.stringify(preview)).not.toContain("extra");
    expect(JSON.stringify(preview)).not.toContain("proof_hash");
    expect(JSON.stringify(preview)).not.toContain("description");
  });

  it("never turns a non-http URL into a link", () => {
    expect(toMilestonePreview({ ...MILESTONE, url: "javascript:alert(1)" })?.url).toBeNull();
    expect(toMilestonePreview({ ...MILESTONE, url: "data:text/html,x" })?.url).toBeNull();
    expect(toMilestonePreview({ ...MILESTONE, url: "/relative" })?.url).toBeNull();
    expect(safeHttpUrl("http://localhost:3000/p")).toBe("http://localhost:3000/p");
  });

  it("an unknown status is null, not a guess", () => {
    expect(toMilestonePreview({ ...MILESTONE, status: "archived" })?.status).toBeNull();
  });

  it("an unlinked, never anchored milestone, and nulls as the contract sends them", () => {
    const preview = toMilestonePreview({ ...MILESTONE, link: null, anchor: null, due_date: null });
    expect(preview?.node).toBeNull();
    expect(preview?.anchor).toBeNull();
    expect(preview?.due_date).toBeNull();
  });

  it("an anchor it cannot read is left out, not half shown", () => {
    expect(toMilestonePreview({ ...MILESTONE, anchor: { ...MILESTONE.anchor, network: "futurenet" } })?.anchor).toBeNull();
    expect(toMilestonePreview({ ...MILESTONE, anchor: { ...MILESTONE.anchor, last_tx_hash: "../x" } })?.anchor).toBeNull();
    expect(toMilestonePreview({ ...MILESTONE, anchor: { ...MILESTONE.anchor, last_action: "delete" } })?.anchor).toBeNull();
  });

  it("refuses what is not a milestone", () => {
    expect(toMilestonePreview(null)).toBeNull();
    expect(toMilestonePreview([])).toBeNull();
    expect(toMilestonePreview({ ...MILESTONE, title: 3 })).toBeNull();
    expect(toMilestonePreview({ ...MILESTONE, project: null })).toBeNull();
  });
});

describe("cardStateFromResponse", () => {
  it("loaded", () => {
    const state = cardStateFromResponse(200, { milestone: toMilestonePreview(MILESTONE) });
    expect(state.state).toBe("loaded");
  });

  it("a 200 without a readable milestone is an error", () => {
    expect(cardStateFromResponse(200, { milestone: null }).state).toBe("error");
  });

  it("no-access, on the code and not the message", () => {
    expect(cardStateFromResponse(403, { code: "QDIT_NO_ACCESS", error: "anything" })).toEqual({ state: "no_access" });
    expect(cardStateFromResponse(403, { code: "FORBIDDEN" }).state).toBe("error");
  });

  it("not-connected, with the connection's problem", () => {
    expect(cardStateFromResponse(409, { code: "QDIT_NOT_CONNECTED", connection: "none" })).toEqual({
      state: "not_connected",
      connection: "none",
    });
    expect(cardStateFromResponse(409, { code: "QDIT_NOT_CONNECTED", connection: "needs_reconnect" })).toEqual({
      state: "not_connected",
      connection: "needs_reconnect",
    });
    expect(cardStateFromResponse(401, { error: "Not signed in" }).state).toBe("not_connected");
  });

  it("anything else is an error with the route's message, and Retry-After on a 429", () => {
    expect(cardStateFromResponse(429, { error: "qdit is busy." }, "12")).toEqual({
      state: "error",
      message: "qdit is busy.",
      retryAfterSeconds: 12,
    });
    expect(cardStateFromResponse(502, null, "12")).toEqual({
      state: "error",
      message: "qdit couldn't be reached. Try again.",
      retryAfterSeconds: null,
    });
  });
});

describe("D-19 and the labels", () => {
  it("maps qdit's status to doqtri's node status (CONTRACT.md section 10)", () => {
    expect(NODE_STATUS_FOR).toEqual({
      proposed: "Planned",
      submitted: "Built",
      approved: "Verified",
      rejected: "Building",
    });
  });

  it("describes the newest anchor and links its transaction on its own network", () => {
    const anchor = toMilestonePreview(MILESTONE)!.anchor!;
    expect(anchorLabel(anchor)).toBe("Submitted on chain, v2");
    expect(anchorLabel({ ...anchor, last_action: "approve", version: 3 })).toBe("Approved on chain, v3");
    expect(anchorTxUrl(anchor)).toBe(`https://stellar.expert/explorer/testnet/tx/${anchor.last_tx_hash}`);
    expect(anchorTxUrl({ ...anchor, network: "mainnet" })).toContain("/explorer/public/tx/");
  });

  it("shows a due date on its own day, whatever the timezone", () => {
    expect(formatDueDate("2026-11-15", "en-US")).toBe("Nov 15, 2026");
    expect(formatDueDate("not-a-date")).toBe("not-a-date");
  });
});
