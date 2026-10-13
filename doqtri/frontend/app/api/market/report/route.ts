import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { MARKET_CONTRACT_ID } from "@/lib/stellar/config";
import { NETWORK } from "@/lib/stellar/smart-wallet-config";
import { TEMPLATE_ID_PATTERN } from "@/lib/market";

/**
 * Report a community template as a copy of another (progress/004). An admin
 * compares the two (/admin/reports); the earlier on-chain listing wins and
 * the copy can be hidden from the gallery. Anyone signed in may report, once
 * per pair.
 */
const MAX_REASON = 1000;

function fail(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function POST(request: Request) {
  if (!MARKET_CONTRACT_ID) return fail("The template marketplace isn't available on this network.", 503);

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Sign in to continue.", 401);

  let input: { templateId?: unknown; originalId?: unknown; reason?: unknown } = {};
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return fail("Invalid JSON", 400);
  }
  const templateId = typeof input.templateId === "string" ? input.templateId : "";
  const originalId = typeof input.originalId === "string" ? input.originalId : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!TEMPLATE_ID_PATTERN.test(templateId) || !TEMPLATE_ID_PATTERN.test(originalId)) return fail("Pick both templates.", 400);
  if (templateId === originalId) return fail("A template can't copy itself.", 400);
  if (reason.length > MAX_REASON) return fail(`Keep the reason under ${MAX_REASON} characters.`, 400);

  const admin = createSupabaseAdminClient();
  const { data: both } = await admin
    .from("market_templates")
    .select("id")
    .in("id", [templateId, originalId])
    .eq("network", NETWORK)
    .neq("status", "pending");
  if ((both ?? []).length !== 2) return fail("Both templates must be in the gallery.", 404);

  const { error } = await admin.from("market_reports").insert({
    network: NETWORK,
    template_id: templateId,
    original_id: originalId,
    reporter_id: user.id,
    reason,
  });
  if (error) {
    if (error.code === "23505") return fail("You've already reported this pair.", 409);
    console.error(`[market/report] ${error.message}`);
    return fail("The report couldn't be saved. Try again.", 500);
  }
  return Response.json({ ok: true });
}
