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
    <div className="border-border bg-elevated flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[12px]">
      <GiftIcon className="text-success size-3.5 shrink-0" strokeWidth={1.75} />
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
        className="text-foreground hover:bg-secondary flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium underline-offset-4 hover:underline"
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
