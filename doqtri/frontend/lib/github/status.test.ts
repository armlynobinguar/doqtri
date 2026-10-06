import { describe, expect, it } from "vitest";
import { combineCi, isReadyToSync, statusRank, suggestStatus, type GitHubItem } from "./status";

const REPO = "armlynobinguar/doqtri";

const issue = (over: Partial<Extract<GitHubItem, { kind: "issue" }>> = {}): GitHubItem => ({
  kind: "issue",
  title: "Plan",
  url: `https://github.com/${REPO}/issues/1`,
  state: "open",
  stateReason: null,
  ...over,
});

const pull = (over: Partial<Extract<GitHubItem, { kind: "pull" }>> = {}): GitHubItem => ({
  kind: "pull",
  title: "Ship it",
  url: `https://github.com/${REPO}/pull/2`,
  state: "open",
  merged: false,
  draft: false,
  headSha: "head123",
  mergeCommitSha: null,
  ci: "none",
  ...over,
});

describe("suggestStatus — issues", () => {
  it("an open issue is Building, pointing at the issue", () => {
    expect(suggestStatus(REPO, issue())).toMatchObject({
      status: "Building",
      artifactRef: `https://github.com/${REPO}/issues/1`,
    });
  });

  it("an issue closed as completed is Verified", () => {
    expect(suggestStatus(REPO, issue({ state: "closed", stateReason: "completed" }))).toMatchObject({
      status: "Verified",
    });
  });

  it("an issue closed with no reason (older issues) counts as completed", () => {
    expect(suggestStatus(REPO, issue({ state: "closed", stateReason: null })).status).toBe("Verified");
  });

  it("an issue closed as not planned suggests nothing", () => {
    expect(suggestStatus(REPO, issue({ state: "closed", stateReason: "not_planned" })).status).toBeNull();
  });
});

describe("suggestStatus — pull requests", () => {
  it("an open PR without CI is Building", () => {
    expect(suggestStatus(REPO, pull()).status).toBe("Building");
  });

  it("a draft stays Building even with green CI", () => {
    expect(suggestStatus(REPO, pull({ draft: true, ci: "success" })).status).toBe("Building");
  });

  it("an open PR with passing CI is Built, pointing at the tested commit", () => {
    expect(suggestStatus(REPO, pull({ ci: "success" }))).toMatchObject({
      status: "Built",
      artifactRef: `https://github.com/${REPO}/commit/head123`,
    });
  });

  it("an open PR with failing CI stays Building and is flagged", () => {
    expect(suggestStatus(REPO, pull({ ci: "failure" }))).toMatchObject({ status: "Building", warning: true });
  });

  it("a merged PR is Verified, pointing at the merge commit", () => {
    expect(
      suggestStatus(REPO, pull({ state: "closed", merged: true, mergeCommitSha: "merge456", ci: "success" })),
    ).toMatchObject({ status: "Verified", artifactRef: `https://github.com/${REPO}/commit/merge456` });
  });

  it("a merged PR with no CI is still Verified", () => {
    expect(suggestStatus(REPO, pull({ state: "closed", merged: true, mergeCommitSha: "m" })).status).toBe(
      "Verified",
    );
  });

  it("a PR merged with failing CI is only Built, and flagged", () => {
    expect(
      suggestStatus(REPO, pull({ state: "closed", merged: true, mergeCommitSha: "m", ci: "failure" })),
    ).toMatchObject({ status: "Built", warning: true });
  });

  it("falls back to the PR URL when GitHub has no merge commit", () => {
    expect(suggestStatus(REPO, pull({ state: "closed", merged: true }))).toMatchObject({
      artifactRef: `https://github.com/${REPO}/pull/2`,
    });
  });

  it("a PR closed without merging suggests nothing", () => {
    expect(suggestStatus(REPO, pull({ state: "closed" })).status).toBeNull();
  });
});

describe("isReadyToSync", () => {
  const verified = suggestStatus(REPO, issue({ state: "closed", stateReason: "completed" }));
  const building = suggestStatus(REPO, issue());

  it("syncs a node that was never set on-chain", () => {
    expect(isReadyToSync(null, building)).toBe(true);
  });

  it("syncs only forward moves", () => {
    expect(isReadyToSync("Building", verified)).toBe(true);
    expect(isReadyToSync("Verified", verified)).toBe(false);
    expect(isReadyToSync("Verified", building)).toBe(false);
  });

  it("never syncs an empty suggestion", () => {
    expect(isReadyToSync(null, { status: null, reason: "closed" })).toBe(false);
  });

  it("orders the lifecycle", () => {
    expect(["Planned", "Building", "Built", "Verified"].map(statusRank)).toEqual([0, 1, 2, 3]);
    expect(statusRank(null)).toBe(-1);
    expect(statusRank("Unknown")).toBe(-1);
  });
});

describe("combineCi", () => {
  const done = (conclusion: string) => ({ status: "completed", conclusion });

  it("is none when nothing reported", () => {
    expect(combineCi([], { state: "pending", total_count: 0 })).toBe("none");
    expect(combineCi([], null)).toBe("none");
  });

  it("passes when every check passed or was skipped", () => {
    expect(combineCi([done("success"), done("skipped"), done("neutral")], null)).toBe("success");
  });

  it("any failure wins, from either system", () => {
    expect(combineCi([done("success"), done("timed_out")], null)).toBe("failure");
    expect(combineCi([done("success")], { state: "error", total_count: 1 })).toBe("failure");
  });

  it("is pending while anything is still running", () => {
    expect(combineCi([done("success"), { status: "in_progress", conclusion: null }], null)).toBe("pending");
    expect(combineCi([], { state: "pending", total_count: 2 })).toBe("pending");
  });
});
