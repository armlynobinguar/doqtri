"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowRightIcon, GiftIcon, XIcon } from "lucide-react";
import { MINDMAP_PROMO, PROMO_PATH } from "@/lib/promo";

const DISMISS_KEY = `promo-dismissed:${MINDMAP_PROMO.id}`;

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

const noSubscribe = () => () => {};

/**
 * Slim promo strip for the mindmap views, pointing at the submission portal.
 * Dismissal is remembered per browser; it is a convenience, not state.
 */
export function MindmapPromoBanner() {
  // Hidden on the server and until the stored dismissal has been read, so a
  // dismissed banner never flashes in.
  const storedDismissed = useSyncExternalStore(noSubscribe, readDismissed, () => true);
  const [dismissedNow, setDismissedNow] = useState(false);

  if (!MINDMAP_PROMO.active || storedDismissed || dismissedNow) return null;

  function dismiss() {
    setDismissedNow(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Storage blocked: the banner stays dismissed for this visit only.
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--glass-lo)] bg-[var(--glass)] px-3 py-1.5 text-[12px] shadow-[inset_0_1px_0_0_var(--glass-hi)]">
      <GiftIcon className="text-foreground size-3.5 shrink-0" strokeWidth={1.5} />
      <p className="min-w-0 flex-1 truncate">
        <span className="text-foreground font-medium">
          Win from a {MINDMAP_PROMO.prizePool} prize pool!
        </span>
        <span className="text-muted-foreground max-sm:hidden">
          {" "}
          Screenshot this map and send up to {MINDMAP_PROMO.maxImages} images to enter.
        </span>
      </p>
      <Link
        href={PROMO_PATH}
        className="bg-primary text-primary-foreground flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 font-semibold transition-colors hover:bg-[color-mix(in_oklch,var(--primary),white_18%)]"
      >
        Submit here
        <ArrowRightIcon className="size-3" />
      </Link>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss promo"
        className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded pointer-coarse:size-8"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
