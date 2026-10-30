import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The save hook (WP-2.5): off with the integration, remaps after a save that
 * changed the text (with the replaced text only when it is that very
 * version), and tells qdit after the response only when a qdit link waits.
 */

const DOC = "30000000-0000-4000-8000-000000000010";

const scheduled: (() => Promise<void>)[] = [];
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => scheduled.push(fn) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock("@/lib/stellar/contract-client", () => ({ DoqtriRegistry: { getDocument: async () => null } }));

let configured = true;
vi.mock("@/lib/integrations/qdit-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/qdit-client")>()),
  qditServerSetup: () => (configured ? { config: {}, tokenKey: Buffer.alloc(32), store: {} } : null),
  createQditClient: () => ({}),
}));

const remapAfterSave = vi.fn();
const syncQditLinks = vi.fn();
vi.mock("@/lib/integrations/qdit-linking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/qdit-linking")>()),
  remapAfterSave: (...args: unknown[]) => remapAfterSave(...args),
  syncQditLinks: (...args: unknown[]) => syncQditLinks(...args),
}));

const { afterNoteSaved, noteBeforeSave } = await import("./qdit-save-hook");

const before = { title: "Plan", markdown: "# A", version: 3 };

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "1");
  configured = true;
  scheduled.length = 0;
  remapAfterSave.mockReset().mockResolvedValue({ changed: 1, qditPending: true });
  syncQditLinks.mockReset().mockResolvedValue({ skipped: false, synced: 1, failed: [] });
});

describe("afterNoteSaved", () => {
  it("does nothing with the integration off: saves are as before", async () => {
    vi.stubEnv("NEXT_PUBLIC_QDIT_INTEGRATION", "");
    await afterNoteSaved({ userId: "u", docId: DOC, baseVersion: 3, savedVersion: 4, markdown: "# B", before });
    expect(remapAfterSave).not.toHaveBeenCalled();
    expect(await noteBeforeSave({} as never, DOC)).toBeNull();
  });

  it("does nothing for a save that changed nothing", async () => {
    await afterNoteSaved({ userId: "u", docId: DOC, baseVersion: 3, savedVersion: 3, markdown: "# A", before });
    expect(remapAfterSave).not.toHaveBeenCalled();
  });

  it("remaps against the replaced text, then tells qdit after the response", async () => {
    await afterNoteSaved({ userId: "u", docId: DOC, baseVersion: 3, savedVersion: 4, markdown: "# New\n# A", before });
    expect(remapAfterSave).toHaveBeenCalledWith(expect.anything(), {
      docId: DOC,
      version: 4,
      title: "Plan",
      markdown: "# New\n# A",
      previousMarkdown: "# A",
    });
    expect(syncQditLinks).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    await scheduled[0]();
    expect(syncQditLinks).toHaveBeenCalledWith(expect.objectContaining({ docId: DOC }));
  });

  it("uses labels only when the text it read is another version", async () => {
    await afterNoteSaved({
      userId: "u",
      docId: DOC,
      baseVersion: 3,
      savedVersion: 4,
      markdown: "# B",
      before: { ...before, version: 2 },
    });
    expect(remapAfterSave).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ previousMarkdown: null }));
  });

  it("schedules nothing when no qdit link waits, or qdit is not set up", async () => {
    remapAfterSave.mockResolvedValue({ changed: 1, qditPending: false });
    await afterNoteSaved({ userId: "u", docId: DOC, baseVersion: 3, savedVersion: 4, markdown: "# B", before });
    remapAfterSave.mockResolvedValue({ changed: 1, qditPending: true });
    configured = false;
    await afterNoteSaved({ userId: "u", docId: DOC, baseVersion: 3, savedVersion: 4, markdown: "# B", before });
    expect(scheduled).toHaveLength(0);
  });

  it("never throws into the save", async () => {
    remapAfterSave.mockRejectedValue(new Error("db down"));
    await expect(
      afterNoteSaved({ userId: "u", docId: DOC, baseVersion: 3, savedVersion: 4, markdown: "# B", before }),
    ).resolves.toBeUndefined();
    remapAfterSave.mockResolvedValue({ changed: 1, qditPending: true });
    syncQditLinks.mockRejectedValue(new Error("qdit down"));
    await afterNoteSaved({ userId: "u", docId: DOC, baseVersion: 3, savedVersion: 4, markdown: "# B", before });
    await expect(scheduled[0]()).resolves.toBeUndefined();
  });
});
