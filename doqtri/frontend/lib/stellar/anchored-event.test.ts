import { afterEach, describe, expect, it, vi } from "vitest";
import { announceAnchored, onAnchored, type AnchoredDetail } from "@/lib/stellar/anchored";

describe("anchored event", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers the doc id and pending flag to a listener until it unsubscribes", () => {
    vi.stubGlobal("window", new EventTarget());
    const seen: AnchoredDetail[] = [];
    const unsubscribe = onAnchored((detail) => seen.push(detail));

    announceAnchored("doc-1", false);
    announceAnchored("doc-2", true);
    unsubscribe();
    announceAnchored("doc-3", false);

    expect(seen).toEqual([
      { docId: "doc-1", pending: false },
      { docId: "doc-2", pending: true },
    ]);
  });

  it("is a no-op on the server", () => {
    expect(() => announceAnchored("doc-1", false)).not.toThrow();
  });
});
