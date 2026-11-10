"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  // Profile → Settings → Reduce motion sets this attribute on <html>.
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduce-motion"] });
  return () => {
    mql.removeEventListener("change", onChange);
    observer.disconnect();
  };
}

function snapshot() {
  return window.matchMedia(QUERY).matches || document.documentElement.hasAttribute("data-reduce-motion");
}

/** Whether to skip motion: the OS setting, or the app's own Reduce motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
