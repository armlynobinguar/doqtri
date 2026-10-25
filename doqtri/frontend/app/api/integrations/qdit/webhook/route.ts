import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { approvalRecorder, supabaseApprovalStore } from "@/lib/integrations/qdit-approvals";
import { qditWebhookSecret } from "@/lib/integrations/qdit-config";
import {
  handleQditWebhook,
  MAX_WEBHOOK_BODY_BYTES,
  readChainOverRpc,
  supabaseStatusStore,
} from "@/lib/integrations/qdit-status-sync";

/**
 * qdit's status webhook (WP-2.8; docs/integration/CONTRACT.md section 9).
 * No session: qdit's HMAC signature over the raw body is the only
 * credential, checked before anything else is read. A linked milestone's
 * event makes doqtri read the milestone's record on chain and record it
 * (lib/integrations/qdit-status-sync.ts); nothing is signed here (D-04).
 * An approval also has its transaction looked up in RPC's event window and
 * kept for the public receipts (WP-3.1).
 *
 * Off (404) unless NEXT_PUBLIC_QDIT_INTEGRATION=1, so the live app has no
 * such endpoint; 503 while QDIT_WEBHOOK_SECRET is missing, so qdit keeps
 * the events and retries them once it is set.
 */
const reply = (status: number, body: Record<string, unknown>) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_QDIT_INTEGRATION !== "1") return reply(404, { error: "Not found" });
  const secret = qditWebhookSecret();
  if (!secret) return reply(503, { error: "Webhook not configured" });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_WEBHOOK_BODY_BYTES) return reply(413, { error: "Body too large" });
  // The raw bytes, exactly as sent: the signature covers them, not a re-encoding.
  const rawBody = new Uint8Array(await request.arrayBuffer());

  const admin = createSupabaseAdminClient();
  const result = await handleQditWebhook({
    rawBody,
    timestamp: request.headers.get("x-qdit-timestamp"),
    signature: request.headers.get("x-qdit-signature"),
    secret,
    nowMs: Date.now(),
    store: supabaseStatusStore(admin),
    readChain: readChainOverRpc,
    recordApproval: approvalRecorder(supabaseApprovalStore(admin)),
  });
  return reply(result.status, result.body);
}
