import { combineCi, type GitHubItem } from "@/lib/github/status";
import type { GitHubRef } from "@/lib/github/refs";

/**
 * Reads one issue or pull request from the GitHub REST API (server-only).
 *
 * GITHUB_TOKEN is optional. Without it only public repositories work and GitHub
 * allows 60 requests an hour per IP — which a serverless deployment shares with
 * every other tenant on that IP — so set a fine-grained, read-only token in
 * production. With it, private repositories the token can read work too.
 */

export type FetchResult =
  | { ok: true; item: GitHubItem }
  | { ok: false; error: "not_found" | "rate_limited" | "unavailable"; message: string };

const API = "https://api.github.com";
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; result: FetchResult }>();

class GitHubHttpError extends Error {
  constructor(readonly status: number, readonly rateLimited: boolean) {
    super(`GitHub responded ${status}`);
  }
}

async function getJson<T>(path: string, token: string | undefined): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "doqtri",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const rateLimited =
      res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
    throw new GitHubHttpError(res.status, rateLimited);
  }
  return (await res.json()) as T;
}

type IssueJson = {
  title: string;
  html_url: string;
  state: "open" | "closed";
  state_reason?: string | null;
  pull_request?: unknown;
};
type PullJson = {
  title: string;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  draft?: boolean;
  merge_commit_sha: string | null;
  head: { sha: string };
};
type CheckRunsJson = { check_runs: { status: string; conclusion: string | null }[] };
type CombinedJson = { state: string; total_count: number };

async function load(ref: GitHubRef, token: string | undefined): Promise<GitHubItem> {
  const base = `/repos/${ref.repo}`;
  // The issues endpoint answers for PRs too and says which one it is.
  const issue = await getJson<IssueJson>(`${base}/issues/${ref.number}`, token);
  if (!issue.pull_request) {
    return {
      kind: "issue",
      title: issue.title,
      url: issue.html_url,
      state: issue.state,
      stateReason: issue.state_reason ?? null,
    };
  }

  const pull = await getJson<PullJson>(`${base}/pulls/${ref.number}`, token);
  // CI is read on the PR head: that is the code the checks actually ran on.
  const [runs, combined] = await Promise.all([
    getJson<CheckRunsJson>(`${base}/commits/${pull.head.sha}/check-runs?per_page=100`, token),
    getJson<CombinedJson>(`${base}/commits/${pull.head.sha}/status`, token).catch(() => null),
  ]);
  return {
    kind: "pull",
    title: pull.title,
    url: pull.html_url,
    state: pull.state,
    merged: pull.merged,
    draft: Boolean(pull.draft),
    headSha: pull.head.sha,
    mergeCommitSha: pull.merge_commit_sha,
    ci: combineCi(runs.check_runs, combined),
  };
}

export async function fetchGitHubItem(ref: GitHubRef): Promise<FetchResult> {
  const key = `${ref.repo.toLowerCase()}#${ref.number}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  let result: FetchResult;
  try {
    result = { ok: true, item: await load(ref, process.env.GITHUB_TOKEN || undefined) };
  } catch (e) {
    if (e instanceof GitHubHttpError && e.rateLimited) {
      result = {
        ok: false,
        error: "rate_limited",
        message: "GitHub rate limit reached. Try again in a few minutes.",
      };
    } else if (e instanceof GitHubHttpError && (e.status === 404 || e.status === 403)) {
      // GitHub answers 404 for private repositories the token cannot see.
      result = {
        ok: false,
        error: "not_found",
        message: "Not found, or the repository is private and Doqtri cannot read it.",
      };
    } else {
      result = { ok: false, error: "unavailable", message: "Could not reach GitHub." };
    }
  }
  // Failures are cached too, briefly, so a broken link cannot hammer the API.
  cache.set(key, { at: Date.now(), result });
  return result;
}
