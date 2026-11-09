"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type RefObject } from "react";
import type { RenamedNote } from "@/lib/rename-note";

/**
 * The note open in the editor, as the vault shell sees it (DOQ-35).
 *
 * The rename dialog lives in the shell, in the layout, and the editor in the
 * page under it. A rename can rewrite the note's title heading, so when the
 * note being renamed is the one open here, the shell hands the request to
 * the editor: it saves pending edits first, keeps its autosave from racing
 * the rename, and adopts the text the server wrote as its saved copy.
 */
export type OpenNote = {
  docId: string;
  /** Runs `request` with the editor's edit session, which the server checks the lock against. */
  rename(request: (session: string) => Promise<RenamedNote>): Promise<RenamedNote>;
};

/** A rename request, given the open editor's session when it goes through one. */
export type RenameRequest = (session?: string) => Promise<RenamedNote>;

/** The shell's side: where the open editor registers, and the rename that goes through it. */
export type OpenNoteSlot = {
  ref: RefObject<OpenNote | null>;
  /**
   * Renames `docId` through the open editor when it is the note open there,
   * else with `request` alone, naming no session (the server then lets the
   * heading change only while nobody holds the note's lock).
   */
  rename(docId: string, request: RenameRequest): Promise<RenamedNote>;
};

const OpenNoteContext = createContext<RefObject<OpenNote | null> | null>(null);

export function useOpenNoteSlot(): OpenNoteSlot {
  const ref = useRef<OpenNote | null>(null);
  const rename = useCallback((docId: string, request: RenameRequest) => {
    const open = ref.current;
    return open?.docId === docId ? open.rename(request) : request();
  }, []);
  return useMemo(() => ({ ref, rename }), [rename]);
}

/** Wraps the pages the shell shows, so the editor among them can register. */
export function OpenNoteProvider({ slot, children }: { slot: OpenNoteSlot; children: React.ReactNode }) {
  return <OpenNoteContext.Provider value={slot.ref}>{children}</OpenNoteContext.Provider>;
}

/** Registers the open editor for as long as it is mounted. Outside a vault shell it does nothing. */
export function useRegisterOpenNote(note: OpenNote): void {
  const ref = useContext(OpenNoteContext);
  useEffect(() => {
    if (!ref) return;
    ref.current = note;
    return () => {
      if (ref.current === note) ref.current = null;
    };
  }, [ref, note]);
}
