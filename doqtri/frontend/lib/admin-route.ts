import { isAdmin } from "@/lib/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * What the admin referral routes share (WP-4.6, DOQ-26): never cached, since
 * they carry payout details, and a 404 for anyone who isn't an admin, signed out
 * included, so the routes don't admit they exist.
 */
export const NO_STORE = { "Cache-Control": "no-store" };

export function adminAnswer(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function adminNotFound(): Response {
  return adminAnswer({ error: "Not found" }, 404);
}

/** The signed-in admin's id, or null for anyone else. */
export async function adminUserId(): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user && isAdmin(user) ? user.id : null;
}

/** The label and the database's error code, and nothing else: an error's message could quote payout details. */
export function logAdminFailure(label: string, error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  console.error(label, typeof code === "string" && /^[A-Za-z0-9]{1,10}$/.test(code) ? code : "unexpected");
}
