"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  createDocLockApi,
  createDocLockController,
  type DocLockController,
  type DocLockState,
} from "@/lib/doc-lock-client";

/**
 * A note's edit lock for the editor (WP-1.6, D-17). Starts on mount, releases
 * on unmount and on page unload (a keepalive request, so it survives the tab
 * closing), and starts again when a page comes back from the back-forward
 * cache. The logic lives in the controller (lib/doc-lock-client.ts); give it
 * callbacks with `controller.setHandlers()` from an effect.
 */
export function useDocLock(docId: string): { lock: DocLockState; controller: DocLockController } {
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
      controller.stop({ keepalive: true });
    };
  }, [controller]);

  const lock = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  return { lock, controller };
}
