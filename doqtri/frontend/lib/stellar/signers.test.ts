import { describe, expect, it } from "vitest";
import { parseSignerRemovals, removalInEffect, shortAddress, type SignerRemoval } from "@/lib/stellar/signers";

const EDITOR = "GBEDITORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "GBOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const removal = (removedAt: string, restoredAt: string | null = null, address = EDITOR): SignerRemoval => ({
  address,
  removedAt,
  restoredAt,
});

describe("removalInEffect", () => {
  const removed = removal("2026-10-24T12:00:04.300Z");

  it("flags an entry that closed after the signer was removed", () => {
    expect(removalInEffect(EDITOR, "2026-10-24T12:00:05Z", [removed])).toBe(removed);
  });

  it("does not flag one that closed before the removal, or in the same instant", () => {
    expect(removalInEffect(EDITOR, "2026-10-24T12:00:04Z", [removed])).toBeNull();
    expect(removalInEffect(EDITOR, "2026-10-24T12:00:04.300Z", [removed])).toBeNull();
  });

  it("only looks at the entry's own signer", () => {
    expect(removalInEffect(OTHER, "2026-10-24T13:00:00Z", [removed])).toBeNull();
  });

  it("does not flag a write made after the signer was added back", () => {
    const lifted = removal("2026-10-24T12:00:00Z", "2026-10-24T13:00:00Z");
    expect(removalInEffect(EDITOR, "2026-10-24T12:30:00Z", [lifted])).toBe(lifted);
    expect(removalInEffect(EDITOR, "2026-10-24T13:00:00Z", [lifted])).toBeNull();
    expect(removalInEffect(EDITOR, "2026-10-24T14:00:00Z", [lifted])).toBeNull();
  });

  it("returns the latest removal in effect when there are several", () => {
    const first = removal("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z");
    const second = removal("2026-10-03T00:00:00Z");
    const third = removal("2026-10-10T00:00:00Z");
    expect(removalInEffect(EDITOR, "2026-10-01T12:00:00Z", [first, second, third])).toBe(first);
    expect(removalInEffect(EDITOR, "2026-10-02T12:00:00Z", [first, second, third])).toBeNull();
    expect(removalInEffect(EDITOR, "2026-10-05T00:00:00Z", [first, second, third])).toBe(second);
    expect(removalInEffect(EDITOR, "2026-10-11T00:00:00Z", [third, first, second])).toBe(third);
  });

  it("ignores unreadable times rather than flagging on them", () => {
    expect(removalInEffect(EDITOR, "not a date", [removed])).toBeNull();
    expect(removalInEffect(EDITOR, "2026-10-24T13:00:00Z", [removal("garbage")])).toBeNull();
  });

  it("flags nothing with no removals, as for a note outside doqtri's database", () => {
    expect(removalInEffect(EDITOR, "2026-10-24T13:00:00Z", [])).toBeNull();
  });
});

describe("parseSignerRemovals", () => {
  it("maps database rows and drops malformed ones", () => {
    expect(
      parseSignerRemovals([
        { address: EDITOR, removed_at: "2026-10-24T12:00:00+00:00", restored_at: null },
        { address: OTHER, removed_at: "2026-10-24T12:00:00+00:00", restored_at: "2026-10-24T13:00:00+00:00" },
        { address: 42, removed_at: "2026-10-24T12:00:00+00:00" },
        { address: EDITOR },
        null,
      ]),
    ).toEqual([
      { address: EDITOR, removedAt: "2026-10-24T12:00:00+00:00", restoredAt: null },
      { address: OTHER, removedAt: "2026-10-24T12:00:00+00:00", restoredAt: "2026-10-24T13:00:00+00:00" },
    ]);
    expect(parseSignerRemovals(null)).toEqual([]);
  });
});

describe("shortAddress", () => {
  it("keeps both ends of an address", () => {
    expect(shortAddress(EDITOR)).toBe("GBED…AAAA");
    expect(shortAddress("short")).toBe("short");
  });
});
