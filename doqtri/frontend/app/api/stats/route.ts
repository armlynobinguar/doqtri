import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { loadSiteStats } from "@/lib/site-stats";

export const runtime = "nodejs";

/**
 * Public, signed-out totals for the landing page: sign-ups, documents, and
 * testnet contract activity. Only counts leave the server, never rows, so the
 * service-role client is safe here. The CDN caches it briefly so visitors
 * polling the page share one Supabase and stellar.expert read.
 */
export async function GET() {
  try {
    const stats = await loadSiteStats(createSupabaseAdminClient());
    return Response.json(stats, {
      headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60" },
    });
  } catch (e) {
    console.error(`[stats] ${(e as Error).message}`);
    return Response.json({ error: "Stats are unavailable right now." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
