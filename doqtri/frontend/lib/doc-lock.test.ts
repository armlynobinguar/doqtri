import { describe, expect, it } from "vitest";
import {
  DOC_LOCK_IDLE_MS,
  editingMessage,
  isLockLive,
  lockErrorAnswer,
  parseDocLockStatus,
} from "@/lib/doc-lock";

const row = {
  document_id: "30000000-0000-4000-8000-000000000010",
  holder: "00000000-0000-4000-8000-000000000003",
  holder_name: "editor",
  acquired_at: "2026-10-24T10:00:00Z",
  heartbeat_at: "2026-10-24T10:05:00Z",
  expires_at: "2026-10-24T10:15:00Z",
  mine: false,
  can_edit: true,
  can_take_over: false,
  version: 4,
};

describe("parseDocLockStatus", () => {
  it("reads a doc_lock_status row", () => {
    expect(parseDocLockStatus(row)).toEqual({
      documentId: row.document_id,
      holder: row.holder,
      holderName: "editor",
      acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
      mine: false,
      canEdit: true,
      canTakeOver: false,
      version: 4,
    });
  });

  it("reads a free lock as a null holder", () => {
    const free = parseDocLockStatus({ ...row, holder: null, holder_name: null, mine: false });
    expect(free?.holder).toBeNull();
    expect(free?.holderName).toBeNull();
  });

  it("accepts a bigint version sent as a string", () => {
    expect(parseDocLockStatus({ ...row, version: "12" })?.version).toBe(12);
  });

  it("rejects anything that is not a status", () => {
    expect(parseDocLockStatus(null)).toBeNull();
    expect(parseDocLockStatus("x")).toBeNull();
    expect(parseDocLockStatus({ ...row, document_id: null })).toBeNull();
    expect(parseDocLockStatus({ ...row, version: "many" })).toBeNull();
  });

  it("only trusts an explicit true for the flags", () => {
    const s = parseDocLockStatus({ ...row, mine: "true", can_edit: 1, can_take_over: undefined });
    expect(s).toMatchObject({ mine: false, canEdit: false, canTakeOver: false });
  });
});

describe("isLockLive", () => {
  const at = Date.parse("2026-10-24T10:00:00Z");
  it("holds for just under ten minutes", () => {
    expect(isLockLive("2026-10-24T10:00:00Z", at + DOC_LOCK_IDLE_MS - 1)).toBe(true);
  });
  it("is free at ten idle minutes, as the database decides", () => {
    expect(isLockLive("2026-10-24T10:00:00Z", at + DOC_LOCK_IDLE_MS)).toBe(false);
  });
  it("is free with no heartbeat or a bad one", () => {
    expect(isLockLive(null, at)).toBe(false);
    expect(isLockLive("not a date", at)).toBe(false);
  });
});

describe("lockErrorAnswer", () => {
  it("maps the save refusals", () => {
    expect(lockErrorAnswer({ code: "DQLCK" })).toMatchObject({ status: 423, code: "NOT_LOCK_HOLDER" });
    expect(lockErrorAnswer({ code: "DQVER" })).toMatchObject({ status: 409, code: "STALE_VERSION" });
  });
  it("tells a takeover refusal from a read-only one", () => {
    expect(
      lockErrorAnswer({
        code: "42501",
        message: "only an admin of the workspace can take over a note someone is editing",
      }),
    ).toMatchObject({ status: 403, code: "TAKEOVER_FORBIDDEN" });
    expect(
      lockErrorAnswer({ code: "42501", message: "you can read this note but not edit it" }),
    ).toMatchObject({ status: 403, code: "READ_ONLY" });
  });
  it("hides whether an unseen note exists", () => {
    expect(lockErrorAnswer({ code: "P0002", message: "note not found" })).toEqual({
      status: 404,
      code: "NOT_FOUND",
      error: "Note not found",
    });
  });
  it("passes anything else through as a 500", () => {
    expect(lockErrorAnswer({ code: "XX000", message: "boom" })).toEqual({
      status: 500,
      code: "ERROR",
      error: "boom",
    });
  });
});

describe("editingMessage", () => {
  it("names the holder, or says someone", () => {
    expect(editingMessage("ana")).toBe("ana is editing this note");
    expect(editingMessage(null)).toBe("Someone else is editing this note");
  });
});
