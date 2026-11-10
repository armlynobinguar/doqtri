"use client";

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import {
  createDocLockApi,
  createDocLockController,
  stopAfterLastSave,
  type LastSave,
  type DocLockController,
  type DocLockState,
} from "@/lib/doc-lock-client";

/**
 * A note's edit lock for the editor (WP-1.6, D-17). Starts on mount, releases
 * on unmount and on page unload (a keepalive request, so it survives the tab
 * closing), and starts again when a page comes back from the back-forward
 * cache. The logic lives in the controller (lib/doc-lock-client.ts); give it
 * callbacks with `controller.setHandlers()` from an effect.
 *
 * The keepalive release is best effort. When it never arrives, the closed or
 * reloaded tab's lock keeps its heartbeat and its session, so a reloaded tab
 * stays "elsewhere" (read-only) until that lock times out (DOC_LOCK_IDLE_MS,
 * ten minutes) or the user clicks Edit here; polling does not clear it.
 *
 * `beforeStop` is the editor's last save (DOQ-43): run on unmount while the
 * lock is still held. The heartbeat stops at once and the release waits for
 * the save to settle (the server releases the lock with that save, so a
 * closing tab loses neither); see stopAfterLastSave(). It returns null when
 * there is nothing to save.
 */
export function useDocLock(
  docId: string,
  beforeStop?: RefObject<(() => LastSave | null) | null>,
): { lock: DocLockState; controller: DocLockController } {
  // The page remounts the editor per note, so one controller per mount, and
  // with it one edit session: each tab, and each visit to a note, holds the
  // lock as itself (lib/doc-lock.ts).
  const [controller] = useState(() => createDocLockController({ api: createDocLockApi(docId) }));

  useEffect(() => {
    controller.start();
    const onPageHide = () => controller.stop({ keepalive: true });
    // A page restored from the back-forward cache starts over: its lock was
    // released when it was hidden.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) controller.start();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      // The editor's latest last save, as it is now: what it is set to on
      // closing is what has to go out.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      stopAfterLastSave(controller, beforeStop?.current?.() ?? null, window);
    };
  }, [controller, beforeStop]);

  const lock = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  return { lock, controller };
}
