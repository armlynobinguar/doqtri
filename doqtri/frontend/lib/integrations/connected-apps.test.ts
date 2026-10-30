import { describe, expect, it } from "vitest";
import { connectedAppsPath, describeQditOutcome, type QditConnectionSummary } from "./connected-apps";

describe("connectedAppsPath", () => {
  it("points at the profile's apps tab with the outcome", () => {
    expect(connectedAppsPath()).toBe("/vault/profile?tab=apps");
    expect(connectedAppsPath("connected")).toBe("/vault/profile?tab=apps&qdit=connected");
    expect(connectedAppsPath("error", "state")).toBe("/vault/profile?tab=apps&qdit=error&reason=state");
    expect(connectedAppsPath("denied", "provider")).toBe("/vault/profile?tab=apps&qdit=denied");
  });
});

describe("describeQditOutcome", () => {
  it("says what happened, from fixed sentences only", () => {
    expect(describeQditOutcome("connected", null)).toEqual({ tone: "success", text: "qdit is connected." });
    expect(describeQditOutcome("denied", null)?.tone).toBe("warning");
    expect(describeQditOutcome("error", "other_user")?.text).toMatch(/another Doqtri account/);
    // An unknown reason (or one a link made up) gets the generic sentence, not the value.
    expect(describeQditOutcome("error", "<b>hi</b>")?.text).not.toContain("<b>");
    expect(describeQditOutcome("error", "toString")?.text).toBe(describeQditOutcome("error", "provider")?.text);
    expect(describeQditOutcome(null, null)).toBeNull();
    expect(describeQditOutcome("whatever", null)).toBeNull();
  });
});

describe("describeQditOutcome: switching accounts (D-66)", () => {
  const switched: QditConnectionSummary = {
    status: "connected",
    accountLabel: "ana",
    subject: "qdit-ana",
    connectedAt: "2026-10-25T08:00:00.000Z",
    previous: { subject: "qdit-ana-old", accountLabel: "ana-old" },
  };

  it("says which account replaced which, from the connection", () => {
    expect(describeQditOutcome("switched", null, switched)).toEqual({
      tone: "success",
      text: "Now connected as ana (was ana-old).",
    });
    // An account without a label goes by its id.
    expect(
      describeQditOutcome("switched", null, { ...switched, accountLabel: null, previous: { subject: "qdit-old", accountLabel: null } })
        ?.text,
    ).toBe("Now connected as qdit-ana (was qdit-old).");
  });

  it("reads as a plain connect when nothing on record was replaced, or the connection is not connected", () => {
    expect(describeQditOutcome("switched", null, { ...switched, previous: null })?.text).toBe("qdit is connected.");
    expect(describeQditOutcome("switched", null, null)?.text).toBe("qdit is connected.");
    expect(describeQditOutcome("switched", null, { ...switched, status: "revoked" })?.text).toBe("qdit is connected.");
    // A plain connect never names the previous account, even if one is on record.
    expect(describeQditOutcome("connected", null, switched)?.text).toBe("qdit is connected.");
  });
});
