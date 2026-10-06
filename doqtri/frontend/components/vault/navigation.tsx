"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DoqtriLoader } from "@/components/brand/doqtri-loader";

/*
 * `loading.tsx` only shows when Next.js decides a route needs it: a revisited
 * or partly prefetched route skips it and leaves the old page frozen until the
 * new one arrives. Every vault navigation instead runs in a transition, and
 * the loader covers the main pane for as long as that transition is pending.
 */

// Long enough for the ring to visibly leave its first node, so a fast
// navigation reads as feedback rather than a flicker.
const MIN_VISIBLE_MS = 450;

type Navigate = (href: string) => void;

const NavigateContext = createContext<Navigate | null>(null);
const PendingContext = createContext(false);

export function NavigationProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Keeps the loader up for MIN_VISIBLE_MS even when the transition settles
  // sooner, e.g. a route the router already has cached.
  const [holding, setHolding] = useState(false);
  const startedAt = useRef(0);

  const navigate = useCallback<Navigate>(
    (href) => {
      startedAt.current = Date.now();
      setHolding(true);
      startTransition(() => router.push(href));
    },
    [router],
  );

  useEffect(() => {
    if (!holding || isPending) return;
    const remaining = MIN_VISIBLE_MS - (Date.now() - startedAt.current);
    const id = setTimeout(() => setHolding(false), Math.max(0, remaining));
    return () => clearTimeout(id);
  }, [holding, isPending]);

  return (
    <NavigateContext.Provider value={navigate}>
      <PendingContext.Provider value={isPending || holding}>{children}</PendingContext.Provider>
    </NavigateContext.Provider>
  );
}

/** Push a vault route with the loader up until the new page commits. */
export function useNavigate(): Navigate {
  const navigate = useContext(NavigateContext);
  const router = useRouter();
  // Outside the vault there is no pane to cover; fall back to a plain push.
  return navigate ?? ((href) => router.push(href));
}

/**
 * A `Link` whose client-side navigations go through `useNavigate`. Prefetch,
 * the real `href` and modifier-clicks (new tab, etc.) behave as normal.
 */
export function NavLink({
  href,
  onNavigate,
  ...props
}: Omit<React.ComponentProps<typeof Link>, "href"> & { href: string }) {
  const navigate = useNavigate();
  return (
    <Link
      {...props}
      href={href}
      onNavigate={(event) => {
        onNavigate?.(event);
        event.preventDefault();
        navigate(href);
      }}
    />
  );
}

/** Covers its parent while a navigation is pending. Parent must be `relative`. */
export function NavigationOverlay() {
  if (!useContext(PendingContext)) return null;
  return (
    <div className="bg-background absolute inset-0 z-20 flex items-center justify-center">
      <DoqtriLoader className="w-20" />
    </div>
  );
}
