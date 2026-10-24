import { describe, expect, it } from "vitest";
import { connectedAppsPath, describeQditOutcome } from "./connected-apps";

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
