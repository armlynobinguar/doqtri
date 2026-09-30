import { createWalletChallenge } from "@/lib/wallet-challenge";
import { isStellarPublicKey } from "@/lib/wallet-auth";

/**
 * Step 1 of wallet sign-in: a short-lived message for the wallet to sign.
 * Step 2 is POST /api/auth/wallet with the signature.
 */
export async function POST(request: Request) {
  let body: { address?: string };
  try {
    body = (await request.json()) as { address?: string };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const address = body.address?.trim();
  if (!address || !isStellarPublicKey(address)) {
    return Response.json({ error: "Invalid Stellar address" }, { status: 400 });
  }

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return Response.json({ error: "Server is not configured" }, { status: 500 });

  const { message, token, expiresAt } = createWalletChallenge(address, secret);
  return Response.json({ message, token, expires_at: expiresAt }, { headers: { "Cache-Control": "no-store" } });
}
