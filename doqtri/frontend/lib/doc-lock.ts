/**
 * Edit locking (WP-1.6, D-17): one person edits a note at a time.
 *
 * The lock lives in `public.doc_locks` and is changed only through
 * `take_doc_lock()`, `release_doc_lock()` and `save_document()`
 * (backend/migrations/20261024150000_doc_locks.sql). This module is the
 * shape both sides agree on: the status the routes return, the timings the
 * client keeps, and how database errors become HTTP answers. It imports
 * nothing server-only, so the browser shares it.
 */

/** A lock with no heartbeat for this long is free. Matches doc_lock_idle_timeout(). */
export const DOC_LOCK_IDLE_MS = 10 * 60_000;

/** How often the holder's client renews while they are editing. */
export const DOC_LOCK_HEARTBEAT_MS = 60_000;

/** How often a client that does not hold the lock checks who does. */
export const DOC_LOCK_POLL_MS = 15_000;

/** SQLSTATE save_document() raises when the caller does not hold a live lock. */
export const LOCK_NOT_HELD = "DQLCK";
/** SQLSTATE save_document() raises when the caller's copy is behind. */
export const STALE_VERSION = "DQVER";

/** A note's lock, from the caller's side (public.doc_lock_status). */
export type DocLockStatus = {
  documentId: string;
  /** Null when the lock is free. */
  holder: string | null;
  /** How to name the holder in "<name> is editing"; null when unknown. */
  holderName: string | null;
  acquiredAt: string | null;
  heartbeatAt: string | null;
  expiresAt: string | null;
  /** The caller holds it. */
  mine: boolean;
  /** The caller may take a free lock (editor and above). */
  canEdit: boolean;
  /** The caller may take a held lock (admin and above). */
  canTakeOver: boolean;
  /** The note's current save version. */
  version: number;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Reads a `doc_lock_status` row as returned by PostgREST; null when it is not one. */
export function parseDocLockStatus(raw: unknown): DocLockStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const documentId = str(row.document_id);
  const version = typeof row.version === "number" ? row.version : Number(row.version);
  if (!documentId || !Number.isSafeInteger(version)) return null;
  return {
    documentId,
    holder: str(row.holder),
    holderName: str(row.holder_name),
    acquiredAt: str(row.acquired_at),
    heartbeatAt: str(row.heartbeat_at),
    expiresAt: str(row.expires_at),
    mine: row.mine === true,
    canEdit: row.can_edit === true,
    canTakeOver: row.can_take_over === true,
    version,
  };
}

/** True while a lock last renewed at `heartbeatAt` still holds at `now`. */
export function isLockLive(heartbeatAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!heartbeatAt) return false;
  const at = Date.parse(heartbeatAt);
  return Number.isFinite(at) && now - at < DOC_LOCK_IDLE_MS;
}

/** "<name> is editing", for a banner or an error. */
export function editingMessage(holderName: string | null): string {
  return `${holderName ?? "Someone else"} is editing this note`;
}

/** An HTTP answer for a database error from one of the lock functions. */
export type LockErrorAnswer = { status: number; code: string; error: string };

/**
 * Maps the errors take_doc_lock(), release_doc_lock() and save_document()
 * raise onto HTTP. Anything unrecognised is a 500 with the database's message.
 */
export function lockErrorAnswer(error: { code?: string | null; message?: string | null }): LockErrorAnswer {
  switch (error.code) {
    case "P0002":
      return { status: 404, code: "NOT_FOUND", error: "Note not found" };
    case "42501":
      return {
        status: 403,
        code: /take over/.test(error.message ?? "") ? "TAKEOVER_FORBIDDEN" : "READ_ONLY",
        error: /take over/.test(error.message ?? "")
          ? "Only an admin of this workspace can take over a note someone is editing."
          : "You can read this note but not change it.",
      };
    case LOCK_NOT_HELD:
      return {
        status: 423,
        code: "NOT_LOCK_HOLDER",
        error: "You are not editing this note any more, so the save was refused.",
      };
    case STALE_VERSION:
      return {
        status: 409,
        code: "STALE_VERSION",
        error: "This note was changed elsewhere since you loaded it. Reload it before saving.",
      };
    default:
      return { status: 500, code: "ERROR", error: error.message ?? "Database error" };
  }
}
