import { describe, expect, it } from "vitest";
import { commitUrl, formatRef, isRepoName, parseGitHubRef, refUrl } from "./refs";

describe("parseGitHubRef", () => {
  it.each([
    ["https://github.com/armlynobinguar/doqtri/pull/12", "armlynobinguar/doqtri", 12],
    ["https://github.com/armlynobinguar/doqtri/pull/12/files", "armlynobinguar/doqtri", 12],
    ["https://github.com/armlynobinguar/doqtri/issues/7?q=1#issuecomment-9", "armlynobinguar/doqtri", 7],
    ["http://www.github.com/a/b/pull/3", "a/b", 3],
    ["  armlynobinguar/doqtri#42  ", "armlynobinguar/doqtri", 42],
    ["my-org/repo.name#1", "my-org/repo.name", 1],
  ])("reads %s", (input, repo, number) => {
    expect(parseGitHubRef(input)).toEqual({ repo, number });
  });

  it.each([
    "",
    "doqtri#12",
    "armlynobinguar/doqtri",
    "armlynobinguar/doqtri#0",
    "armlynobinguar/doqtri#-3",
    "armlynobinguar/doqtri#99999999999",
    "https://github.com/armlynobinguar/doqtri",
    "https://github.com/armlynobinguar/doqtri/commit/abc123",
    "https://gitlab.com/a/b/pull/1",
    "https://github.com.evil.example/a/b/pull/1",
    "../..#1",
    "a b/c#1",
  ])("rejects %j", (input) => {
    expect(parseGitHubRef(input)).toBeNull();
  });
});

describe("formatting", () => {
  it("round-trips a reference", () => {
    const ref = { repo: "a/b", number: 9 };
    expect(formatRef(ref)).toBe("a/b#9");
    expect(parseGitHubRef(formatRef(ref))).toEqual(ref);
    expect(refUrl(ref)).toBe("https://github.com/a/b/issues/9");
    expect(commitUrl("a/b", "deadbeef")).toBe("https://github.com/a/b/commit/deadbeef");
  });

  it("validates repository names like the database does", () => {
    expect(isRepoName("armlynobinguar/doqtri")).toBe(true);
    expect(isRepoName("a/..")).toBe(false);
    expect(isRepoName("a/b/c")).toBe(false);
    expect(isRepoName("a")).toBe(false);
  });
});
