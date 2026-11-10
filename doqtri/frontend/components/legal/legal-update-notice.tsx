"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { XIcon } from "lucide-react";
import { useLegalLive } from "@/components/legal/legal-live";
import { PRIVACY_PATH, TERMS_PATH } from "@/components/legal/legal-links";
import { LEGAL_NOTICE_DISMISS_KEY } from "@/lib/legal-copy";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(LEGAL_NOTICE_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

const noSubscribe = () => () => {};

/**
 * Tells people already using the vault that Terms and a Privacy Policy now
 * apply. Shown until dismissed, and dismissal is per browser: it is not a
 * record of who has seen it (a question for the legal review, D-114).
 */
export function LegalUpdateNotice() {
  const live = useLegalLive();
  // Hidden on the server and until the stored dismissal has been read, so a
  // dismissed notice never flashes in.
  const storedDismissed = useSyncExternalStore(noSubscribe, readDismissed, () => true);
  const [dismissedNow, setDismissedNow] = useState(false);

  if (!live || storedDismissed || dismissedNow) return null;

  function dismiss() {
    setDismissedNow(true);
    try {
      window.localStorage.setItem(LEGAL_NOTICE_DISMISS_KEY, "1");
    } catch {
      // Storage blocked: the notice stays dismissed for this visit only.
    }
  }

  return (
    <div
      data-testid="legal-update-notice"
      className="flex shrink-0 items-center gap-2 border-b border-[var(--glass-lo)] bg-[var(--glass)] px-3 py-1.5 text-[12px] shadow-[inset_0_1px_0_0_var(--glass-hi)]"
    >
      <p className="text-muted-foreground min-w-0 flex-1 leading-snug">
        Our{" "}
        <Link href={TERMS_PATH} className="text-foreground underline underline-offset-2">
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link href={PRIVACY_PATH} className="text-foreground underline underline-offset-2">
          Privacy Policy
        </Link>{" "}
        now apply to your account.
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss notice"
        className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded pointer-coarse:size-8"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
