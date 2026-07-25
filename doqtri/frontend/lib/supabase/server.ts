import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Session-bound server client. Reads the auth cookies, so every query runs as
 * the signed-in user and RLS applies. Use this to *verify who the caller is*.
 *
 * `cookies()` is async in Next 16, hence the awaited factory.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components may not set cookies. Session refresh happens
            // in proxy.ts, so it is safe to ignore this here.
          }
        },
      },
    },
  );
}

/**
 * Service-role client. Bypasses RLS entirely, so it must never be handed a
 * `user_id` that did not come from a verified session — see the API routes,
 * which resolve the user via `createSupabaseServerClient()` first.
 *
 * Server-only: importing this from a client component will fail at build time
 * because SUPABASE_SERVICE_ROLE_KEY is not a NEXT_PUBLIC_ var.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local (Dashboard -> Project Settings -> API keys -> service_role).",
    );
  }

  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
