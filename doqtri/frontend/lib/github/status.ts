import type { NodeStatus } from "@/lib/stellar/types";
import { commitUrl } from "@/lib/github/refs";

/**
 * Turning GitHub facts into a suggested node status. Pure, so the rules are
 * unit-tested; the route that fetches the facts is lib/github/fetch.ts.
 *
 * The node lifecycle is Planned → Building → Built → Verified:
 *
 *   issue open                      → Building
 *   issue closed as completed       → Verified   (artifact: the issue)
 *   PR open / draft / CI not green  → Building   (artifact: the PR)
 *   PR open with CI passing         → Built      (artifact: the head commit)
 *   PR merged, CI not failing       → Verified   (artifact: the merge commit)
 *   PR merged but CI failed         → Built      (flagged, not Verified)
 *   PR closed unmerged, issue not planned → no suggestion
 *
 * Suggestions only ever move a node forward; see isReadyToSync().
 */

/** Combined CI result for one commit. "none" = no checks reported at all. */
export type CiState = "success" | "failure" | "pending" | "none";

export type GitHubItem =
  | {
      kind: "issue";
      title: string;
      url: string;
      state: "open" | "closed";
      /** "completed", "not_planned", "reopened", or null on older issues. */
      stateReason: string | null;
    }
  | {
      kind: "pull";
      title: string;
      url: string;
      state: "open" | "closed";
      merged: boolean;
      draft: boolean;
      headSha: string;
      mergeCommitSha: string | null;
      ci: CiState;
    };

export type Suggestion =
  | { status: NodeStatus; artifactRef: string; reason: string; warning?: boolean }
  | { status: null; reason: string };

const RANK: Record<NodeStatus, number> = { Planned: 0, Building: 1, Built: 2, Verified: 3 };

/** Position in the lifecycle; -1 for "never set on-chain" or an unknown tag. */
export function statusRank(status: string | null | undefined): number {
  return status != null && status in RANK ? RANK[status as NodeStatus] : -1;
}

export function suggestStatus(repo: string, item: GitHubItem): Suggestion {
  if (item.kind === "issue") {
    if (item.state === "open") {
      return { status: "Building", artifactRef: item.url, reason: "Issue is open" };
    }
    if (item.stateReason === "not_planned") {
      return { status: null, reason: "Issue was closed as not planned" };
    }
    return { status: "Verified", artifactRef: item.url, reason: "Issue closed as completed" };
  }

  if (item.merged) {
    const artifactRef = item.mergeCommitSha ? commitUrl(repo, item.mergeCommitSha) : item.url;
    if (item.ci === "failure") {
      return {
        status: "Built",
        artifactRef,
        reason: "Merged, but CI failed on the pull request",
        warning: true,
      };
    }
    return { status: "Verified", artifactRef, reason: "Pull request merged" };
  }

  if (item.state === "closed") {
    return { status: null, reason: "Pull request was closed without merging" };
  }
  if (item.draft) {
    return { status: "Building", artifactRef: item.url, reason: "Draft pull request" };
  }
  if (item.ci === "success") {
    return {
      status: "Built",
      artifactRef: commitUrl(repo, item.headSha),
      reason: "Pull request open with CI passing",
    };
  }
  if (item.ci === "failure") {
    return { status: "Building", artifactRef: item.url, reason: "CI is failing", warning: true };
  }
  return {
    status: "Building",
    artifactRef: item.url,
    reason: item.ci === "pending" ? "CI is still running" : "Pull request is open",
  };
}

/**
 * Whether a suggestion should be signed: only when it moves the node forward
 * from what the ledger already says. A node is never moved backwards
 * automatically; that stays a deliberate manual sync.
 */
export function isReadyToSync(chainStatus: string | null, suggestion: Suggestion): boolean {
  return suggestion.status != null && statusRank(suggestion.status) > statusRank(chainStatus);
}

type CheckRun = { status: string; conclusion: string | null };
type CombinedStatus = { state: string; total_count: number };

/**
 * Folds GitHub's two CI systems into one result: check runs (GitHub Actions and
 * most apps) and the older commit statuses. Any failure wins; then anything
 * still running; success needs at least one reported check and no failures.
 */
export function combineCi(checkRuns: CheckRun[], combined: CombinedStatus | null): CiState {
  const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);
  const PASSED = new Set(["success", "neutral", "skipped"]);
  const states: CiState[] = [];

  for (const run of checkRuns) {
    if (run.status !== "completed") states.push("pending");
    else if (run.conclusion && FAILED.has(run.conclusion)) states.push("failure");
    else if (run.conclusion && PASSED.has(run.conclusion)) states.push("success");
    else states.push("pending");
  }
  if (combined && combined.total_count > 0) {
    if (combined.state === "failure" || combined.state === "error") states.push("failure");
    else if (combined.state === "success") states.push("success");
    else states.push("pending");
  }

  if (states.length === 0) return "none";
  if (states.includes("failure")) return "failure";
  if (states.includes("pending")) return "pending";
  return "success";
}
