"use client";

import { useEffect } from "react";

/**
 * Rendered by the vault layout only while the referral cookie is set. Asks
 * the server to record the referral; the response clears the cookie, so this
 * runs once. Failures are silent: the cookie stays and the next visit retries.
 */
export function ReferralClaim() {
  useEffect(() => {
    void fetch("/api/referrals/claim", { method: "POST" }).catch(() => {});
  }, []);
  return null;
}
