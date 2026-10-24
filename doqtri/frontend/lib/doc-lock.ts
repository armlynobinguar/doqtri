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

/**
 * A lock is held by one user from one edit session: one open editor, in one
 * tab. Each editor makes a random session id when it opens a note and names
 * it on every lock call and save, so a second tab of the same user neither
 * renews, saves under, nor releases the first tab's lock.
 */
export function newEditSession(): string {
  return globalThis.crypto.randomUUID();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The edit session out of a request value, or null when it is not a uuid. */
export function parseEditSession(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

/** A note's lock, from the caller's side (public.doc_lock_status). */
export type DocLockStatus = {
  documentId: string;
  /** Null when the lock is free. */
  holder: string | null;
  /**
   * How to name the holder in "<name> is editing"; null when unknown, and
   * always for a viewer (the database names holders to editors and above).
   */
  holderName: string | null;
  acquiredAt: string | null;
  heartbeatAt: string | null;
  expiresAt: string | null;
  /** The caller holds it, from this edit session. */
  mine: boolean;
  /** The caller holds it from another edit session (another tab or device). */
  mineElsewhere: boolean;
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
    mineElsewhere: row.mine_elsewhere === true,
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

/** What the editor says when the caller is editing the note in another tab. */
export const EDITING_ELSEWHERE =
  "You are editing this note in another tab or window";

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
    case "22023":
      return { status: 400, code: "BAD_SESSION", error: "This editor has no edit session. Reload the note." };
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
