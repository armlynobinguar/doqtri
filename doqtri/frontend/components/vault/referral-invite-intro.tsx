import Link from "next/link";
import { GiftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { REFERRAL_ACTIVITY_THRESHOLD, REFERRAL_REWARD_PHP } from "@/lib/referral-program";

/**
 * The top of Profile → Invite. Until the referral dashboard goes live
 * (the legal pages gate, lib/legal.ts) it stays exactly what it was: on a phone, its link
 * is the way to the dashboard, since the ribbon is desktop-only.
 */
export function ReferralInviteIntro({ live }: { live: boolean }) {
  if (!live) {
    return (
      <p className="text-muted-foreground text-[13px]">
        Share your link, let someone scan your QR code, or give them your code to enter when they sign up.
        Anyone who then creates an account is counted as your referral.
      </p>
    );
  }
  return (
    <>
      <p className="text-muted-foreground text-[13px]" data-testid="referral-invite-rule">
        Share your link, let someone scan your QR code, or give them your code to enter when they sign up.
        Anyone who then creates an account is your referral, and earns you {REFERRAL_REWARD_PHP} PHP once they&apos;ve
        made {REFERRAL_ACTIVITY_THRESHOLD} on-chain activities.
      </p>
      <Button
        size="sm"
        variant="outline"
        className="justify-self-start"
        nativeButton={false}
        render={<Link href="/vault/referrals" data-testid="referral-view-dashboard" />}
      >
        <GiftIcon />
        View your referrals
      </Button>
    </>
  );
}
