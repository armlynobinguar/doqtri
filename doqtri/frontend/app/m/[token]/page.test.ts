import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * /m/<token> (WP-4.7, DOQ-53): never indexed and no Referer, a 404 for a link
 * the anon read does not answer, and otherwise the frozen graph and style
 * handed to the read-only view, with nothing in them but labels and shape.
 */

const load = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mindmap-share-server", () => ({ loadMindmapShare: load }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
);
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/components/share/shared-mindmap", () => ({ SharedMindmap: () => null }));

const { default: Page, metadata } = await import("./page");
const { SharedMindmap } = await import("@/components/share/shared-mindmap");

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const visit = (token: string) => Page({ params: Promise.resolve({ token }) } as never);

beforeEach(() => {
  load.mockReset();
  notFound.mockClear();
});

describe("/m/[token]", () => {
  it("is never indexed and sends no Referer", () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false, googleBot: { index: false, follow: false } });
    expect(metadata.referrer).toBe("no-referrer");
  });

  it("is a 404 when the link is unknown or revoked", async () => {
    load.mockResolvedValue(null);
    await expect(visit(TOKEN)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(load).toHaveBeenCalledWith(TOKEN);
  });

  it("hands the frozen graph, style and date to the read-only view", async () => {
    const graph = { nodes: [{ id: "n0", label: "Plan", kind: "document", depth: 0 }], links: [] };
    load.mockResolvedValue({ graph, style: { textScale: 1.2 }, createdAt: "2026-11-12T09:00:00Z" });
    const element = await visit(TOKEN);
    expect(isValidElement(element)).toBe(true);
    expect(element.type).toBe(SharedMindmap);
    expect(element.props).toEqual({ graph, style: { textScale: 1.2 }, createdAt: "2026-11-12T09:00:00Z" });
    expect(notFound).not.toHaveBeenCalled();
  });
});
