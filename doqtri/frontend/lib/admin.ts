import type { User } from "@supabase/supabase-js";
import { walletAddressFromEmail } from "@/lib/wallet-address";

/**
 * Doqtri staff, from DOQTRI_ADMINS: a comma-separated list where each entry is
 * an auth user id, an email, or a Stellar wallet address (for wallet logins,
 * whose auth email is synthetic). Server-only; unset means nobody is an admin.
 */
export function isAdmin(user: Pick<User, "id" | "email"> | null): boolean {
  if (!user) return false;
  const admins = adminEntries(process.env.DOQTRI_ADMINS);
  if (admins.size === 0) return false;

  const email = user.email?.toLowerCase();
  const wallet = walletAddressFromEmail(user.email)?.toLowerCase();
  return (
    admins.has(user.id.toLowerCase()) ||
    (email !== undefined && admins.has(email)) ||
    (wallet !== undefined && admins.has(wallet))
  );
}

export function adminEntries(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}
