import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * GitHub links regression (WP-2.5): the status check reads GitHub rows only,
 * now that node_links also holds qdit milestones, and answers exactly as
 * before for them.
 */

const DOC = "30000000-0000-4000-8000-000000000010";

let user: { id: string } | null = { id: "u1" };
let rows: Record<string, unknown>[] = [];
const filters: [string, unknown][] = [];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => {
      const query = {
        select: () => query,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return query;
        },
        order: () => query,
        limit: async () => ({
          data: rows.filter((r) => filters.every(([col, val]) => r[col] === val)),
          error: null,
        }),
      };
      return query;
    },
  }),
}));

const fetchGitHubItem = vi.fn();
vi.mock("@/lib/github/fetch", () => ({ fetchGitHubItem: (...args: unknown[]) => fetchGitHubItem(...args) }));

const { POST } = await import("./route");

const post = (body: unknown) =>
  new Request("http://localhost/api/github/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  user = { id: "u1" };
  filters.length = 0;
  fetchGitHubItem.mockReset();
  rows = [
    { id: "gh", document_id: DOC, provider: "github", node_id: "h0", node_label: "A", repo: "acme/app", number: 7 },
    { id: "q", document_id: DOC, provider: "qdit", node_id: "h1", node_label: "B", repo: null, number: null },
  ];
});

describe("POST /api/github/status", () => {
  it("refuses a signed-out caller", async () => {
    user = null;
    expect((await POST(post({ docId: DOC }))).status).toBe(401);
  });

  it("needs a document id", async () => {
    expect((await POST(post({ docId: "nope" }))).status).toBe(400);
  });

  it("checks GitHub links only, never a qdit row", async () => {
    fetchGitHubItem.mockResolvedValue({
      ok: true,
      item: {
        kind: "pull",
        title: "Ship it",
        url: "https://github.com/acme/app/pull/7",
        state: "closed",
        merged: true,
        draft: false,
        headSha: "abc",
        mergeCommitSha: "def",
        ci: "success",
      },
    });
    const res = await POST(post({ docId: DOC }));
    expect(res.status).toBe(200);
    expect(filters).toContainEqual(["provider", "github"]);
    expect(fetchGitHubItem).toHaveBeenCalledTimes(1);
    expect(fetchGitHubItem).toHaveBeenCalledWith({ repo: "acme/app", number: 7 });
    const body = (await res.json()) as { links: { linkId: string; repo: string; suggestion?: unknown }[] };
    expect(body.links.map((l) => l.linkId)).toEqual(["gh"]);
    expect(body.links[0]).toMatchObject({ repo: "acme/app", number: 7, nodeId: "h0" });
    expect(body.links[0].suggestion).toMatchObject({ status: "Verified" });
  });

  it("reports a GitHub fetch failure per link, as before", async () => {
    fetchGitHubItem.mockResolvedValue({ ok: false, error: "not_found", message: "acme/app#7 was not found" });
    const body = (await (await POST(post({ docId: DOC }))).json()) as { links: { error?: string }[] };
    expect(body.links).toEqual([expect.objectContaining({ linkId: "gh", error: "acme/app#7 was not found" })]);
  });
});
