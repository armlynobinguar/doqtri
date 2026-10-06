/**
 * A reference to one GitHub issue or pull request. Issues and PRs share one
 * number space per repository, so repo + number is enough; whether it is a PR
 * is discovered when it is fetched.
 */
export type GitHubRef = { repo: string; number: number };

const NAME = "[A-Za-z0-9_.-]+";
const URL_RE = new RegExp(
  `^https?://(?:www\\.)?github\\.com/(${NAME})/(${NAME})/(?:pull|issues)/(\\d+)(?:[/?#].*)?$`,
  "i",
);
const SHORT_RE = new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`);
const REPO_RE = new RegExp(`^${NAME}/${NAME}$`);

/** Largest issue number accepted; matches the Postgres integer column. */
const MAX_NUMBER = 2_147_483_647;

/**
 * Accepts a GitHub issue or PR URL (`https://github.com/o/r/pull/12`, with or
 * without a trailing `/files`, query or fragment) or the `o/r#12` shorthand.
 * Returns null for anything else.
 */
export function parseGitHubRef(input: string): GitHubRef | null {
  const text = input.trim();
  const m = URL_RE.exec(text) ?? SHORT_RE.exec(text);
  if (!m) return null;
  const [, owner, name, digits] = m;
  // "." and ".." are not repository names, and the regex alone would allow them.
  if (/^\.+$/.test(owner) || /^\.+$/.test(name)) return null;
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_NUMBER) return null;
  return { repo: `${owner}/${name.replace(/\.git$/i, "")}`, number };
}

/** True for a well-formed `owner/name`; the same rule the database enforces. */
export function isRepoName(repo: string): boolean {
  return REPO_RE.test(repo) && !repo.split("/").some((part) => /^\.+$/.test(part));
}

/** `owner/name#12`. */
export function formatRef(ref: GitHubRef): string {
  return `${ref.repo}#${ref.number}`;
}

/** Web URL of an issue; GitHub redirects it to the PR page when it is a PR. */
export function refUrl(ref: GitHubRef): string {
  return `https://github.com/${ref.repo}/issues/${ref.number}`;
}

/** Web URL of a commit. */
export function commitUrl(repo: string, sha: string): string {
  return `https://github.com/${repo}/commit/${sha}`;
}
