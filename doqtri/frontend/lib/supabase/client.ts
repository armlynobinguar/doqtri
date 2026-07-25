import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser client. Uses the anon key and is therefore always subject to RLS —
 * it can only ever see the signed-in user's own rows.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
