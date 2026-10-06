import * as React from "react"

const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

export function useIsMobile() {
  // The server has no viewport; report desktop there, as the old
  // `useState(undefined)` + effect version did on its first render.
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false
  )
}

/*
 * The vault switches to its phone layout below Tailwind's `lg`, not `md`: its
 * desktop layout docks three panes beside the editor, which leaves a portrait
 * tablet a ~300px column to write in. Keep in step with the `lg:`/`max-lg:`
 * classes in components/vault and the editor media query in globals.css.
 */
const COMPACT_QUERY = "(max-width: 1023px)"

function subscribeCompact(onChange: () => void) {
  const mql = window.matchMedia(COMPACT_QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

export function useIsCompactVault() {
  return React.useSyncExternalStore(
    subscribeCompact,
    () => window.matchMedia(COMPACT_QUERY).matches,
    () => false
  )
}
