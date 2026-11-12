import { describe, expect, it } from "vitest";
import { buildGlobalMindmap } from "@/lib/global-mindmap";
import { serializeGlobalMindmap } from "@/lib/integrations/qdit-hackathon";
import {
  isMindmapShareUrl,
  MAX_STATUS_TOKENS,
  mindmapShareUrl,
  parseSharedGraph,
  parseStatusRequest,
  SHARE_NOT_FOUND_REWRITE,
  SHARE_TOKEN_PATTERN,
  shareTokenFromPath,
} from "@/lib/mindmap-share";
import type { Doc } from "@/lib/types";

/*
 * Public mindmap links (WP-4.7, DOQ-53): the link doqtri sends as
 * `mindmap_url` must always pass qdit's check (QDIT-66): https, host equal to
 * qdit's DOQTRI_ORIGIN, path exactly /m/<token> with a 22-64 character
 * [A-Za-z0-9_-] token, no query or fragment. And the page's graph holds
 * labels only.
 */

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345"; // 32, as newShareToken() makes

/** qdit's rule, written out independently of doqtri's code, for the host it is configured with. */
function qditAccepts(value: string, doqtriOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.origin === doqtriOrigin &&
    /^\/m\/[A-Za-z0-9_-]{22,64}$/.test(url.pathname) &&
    !value.includes("?") &&
    !value.includes("#")
  );
}

describe("mindmapShareUrl", () => {
  it.each([
    ["a bare origin", "https://www.doqtri.xyz"],
    ["a trailing slash", "https://www.doqtri.xyz/"],
    ["several trailing slashes", "https://www.doqtri.xyz///"],
    ["a path", "https://www.doqtri.xyz/app/"],
    ["a query and fragment", "https://www.doqtri.xyz/?x=1#top"],
    ["an uppercase host", "https://WWW.Doqtri.XYZ"],
    ["the default port", "https://www.doqtri.xyz:443"],
    ["surrounding spaces", "  https://www.doqtri.xyz  "],
    ["credentials", "https://user:pass@www.doqtri.xyz"],
  ])("builds https://www.doqtri.xyz/m/<token> from %s", (_name, site) => {
    const url = mindmapShareUrl(site, TOKEN);
    expect(url).toBe(`https://www.doqtri.xyz/m/${TOKEN}`);
    expect(qditAccepts(url!, "https://www.doqtri.xyz")).toBe(true);
    expect(isMindmapShareUrl(url)).toBe(true);
  });

  it("keeps a non-default port, as part of the origin qdit compares", () => {
    expect(mindmapShareUrl("https://preview.doqtri.test:8443/", TOKEN)).toBe(`https://preview.doqtri.test:8443/m/${TOKEN}`);
  });

  it.each([
    ["http", "http://localhost:3000"],
    ["not a URL", "doqtri.xyz"],
    ["empty", ""],
    ["another scheme", "ftp://doqtri.xyz"],
  ])("makes no link for a site that is %s", (_name, site) => {
    expect(mindmapShareUrl(site, TOKEN)).toBeNull();
  });

  it.each([
    ["too short", "a".repeat(21)],
    ["too long", "a".repeat(65)],
    ["with a slash", `${"a".repeat(21)}/b`],
    ["with base64's + or =", `${"a".repeat(21)}+=`],
  ])("makes no link for a token %s", (_name, token) => {
    expect(mindmapShareUrl("https://www.doqtri.xyz", token)).toBeNull();
  });

  it("takes tokens of 22 and 64 characters, qdit's bounds", () => {
    for (const token of ["a".repeat(22), "Z-_9".repeat(16)]) {
      const url = mindmapShareUrl("https://www.doqtri.xyz", token)!;
      expect(qditAccepts(url, "https://www.doqtri.xyz")).toBe(true);
    }
  });
});

describe("isMindmapShareUrl, the builder's own check", () => {
  it.each([
    ["http", `http://www.doqtri.xyz/m/${TOKEN}`],
    ["a query", `https://www.doqtri.xyz/m/${TOKEN}?x=1`],
    ["an empty query", `https://www.doqtri.xyz/m/${TOKEN}?`],
    ["a fragment", `https://www.doqtri.xyz/m/${TOKEN}#top`],
    ["a trailing slash", `https://www.doqtri.xyz/m/${TOKEN}/`],
    ["a deeper path", `https://www.doqtri.xyz/m/${TOKEN}/x`],
    ["another path", `https://www.doqtri.xyz/d/${TOKEN}`],
    ["a short token", "https://www.doqtri.xyz/m/abc"],
    ["credentials", `https://u:p@www.doqtri.xyz/m/${TOKEN}`],
    ["a non-canonical host", `https://WWW.doqtri.xyz/m/${TOKEN}`],
    ["not a string", 42],
  ])("refuses %s", (_name, value) => {
    expect(isMindmapShareUrl(value)).toBe(false);
  });
});

describe("shareTokenFromPath", () => {
  it("reads the token of /m/<token>", () => {
    expect(shareTokenFromPath(`/m/${TOKEN}`)).toBe(TOKEN);
  });

  it.each(["/m/", "/m/short", `/m/${TOKEN}/x`, `/d/${TOKEN}`, `/m/${TOKEN}%20`])("finds none in %s", (path) => {
    expect(shareTokenFromPath(path)).toBeNull();
  });

  it("matches the column's check", () => {
    expect(SHARE_TOKEN_PATTERN.source).toBe("^[A-Za-z0-9_-]{22,64}$");
  });

  it("rewrites to a private (underscore) path, which the app router never routes", () => {
    expect(SHARE_NOT_FOUND_REWRITE).toMatch(/^\/_[a-z-]+$/);
  });
});

const doc = (id: string, title: string, markdown: string): Doc =>
  ({ id, title, markdown, mindmap: null, updatedAt: "2026-11-12T00:00:00Z" }) as unknown as Doc;

describe("parseSharedGraph", () => {
  it("keeps id, label, kind and depth only, and links between kept nodes", () => {
    expect(
      parseSharedGraph({
        nodes: [
          { id: "doc:1", label: "Plan", kind: "document", depth: 0, doc_ids: ["1"], href: "/vault/1/mindmap" },
          { id: "concept:x", label: "X", kind: "concept", depth: 1, summary: "secret summary" },
          { id: "bad-kind", label: "Y", kind: "script", depth: 1 },
          { id: "bad-depth", label: "Z", kind: "concept", depth: -1 },
          { id: "doc:1", label: "Duplicate", kind: "document", depth: 0 },
          "not a node",
        ],
        links: [
          { source: "doc:1", target: "concept:x" },
          { source: "doc:1", target: "bad-kind" },
          { source: "doc:1", target: "doc:1" },
          null,
        ],
      }),
    ).toEqual({
      nodes: [
        { id: "doc:1", label: "Plan", kind: "document", depth: 0 },
        { id: "concept:x", label: "X", kind: "concept", depth: 1 },
      ],
      links: [{ source: "doc:1", target: "concept:x" }],
    });
  });

  it.each([null, [], { nodes: {} }, { nodes: [] }, "graph"])("is null for %o", (value) => {
    expect(parseSharedGraph(value)).toBeNull();
  });

  it("carries none of a note's text from the global mindmap as sent", () => {
    const docs = [
      doc("10000000-0000-4000-8000-000000000001", "Plan", "# Launch\n\nBODY-SECRET-ONE paragraph.\n\n## Budget\n\nBODY-SECRET-TWO"),
      doc("10000000-0000-4000-8000-000000000002", "Notes", "Plain text BODY-SECRET-THREE, links [[Plan]]."),
    ];
    const sent = serializeGlobalMindmap(docs);
    const shown = parseSharedGraph(sent)!;
    expect(JSON.stringify(shown)).not.toMatch(/BODY-SECRET|doc_ids/);
    expect(shown.nodes.map((node) => node.label).sort()).toEqual(
      buildGlobalMindmap(docs)
        .nodes.map((node) => node.label)
        .sort(),
    );
  });
});

describe("parseStatusRequest (DOQ-54)", () => {
  const T = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

  it("takes 1 to 500 tokens of the /m/ shape", () => {
    expect(parseStatusRequest({ tokens: [T, T] })).toEqual([T, T]);
    expect(parseStatusRequest({ tokens: Array(MAX_STATUS_TOKENS).fill(T) })).toHaveLength(500);
    expect(parseStatusRequest({ tokens: [T], later_field: true })).toEqual([T]);
  });

  it.each([
    ["not an object", [T]],
    ["null", null],
    ["no tokens", {}],
    ["an empty list", { tokens: [] }],
    ["tokens not an array", { tokens: T }],
    ["501 tokens", { tokens: Array(501).fill(T) }],
    ["a short token", { tokens: [T, "short"] }],
    ["a token with a slash", { tokens: [`${T}/x`] }],
    ["a whole link", { tokens: [`https://doqtri.test/m/${T}`] }],
    ["a number", { tokens: [12] }],
  ])("refuses %s", (_name, body) => {
    expect(parseStatusRequest(body)).toBeNull();
  });
});
