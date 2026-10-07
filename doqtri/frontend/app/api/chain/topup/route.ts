import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { walletAddressFromEmail } from "@/lib/wallet-address";
import { NETWORK, USER_PAYS_FEES } from "@/lib/stellar/smart-wallet-config";
import { RelayRejection } from "@/lib/stellar/relay-validation";
import { topUpWallet } from "@/lib/stellar/friendbot-topup";
import { xlmBalanceStroops } from "@/lib/stellar/wallet-balance";

/**
 * Testnet only: tops up the caller's passkey wallet with free test XLM so it
 * can pay for its own writes (progress/003). Refused while the wallet still
 * has plenty, which keeps one account from draining Friendbot through us.
 */
const TOP_UP_BELOW_STROOPS = BigInt(100) * BigInt(10_000_000); // 100 XLM

export async function POST() {
  if (!USER_PAYS_FEES) return Response.json({ error: "Top-ups aren't available on this network." }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  if (walletAddressFromEmail(user.email)) {
    return Response.json({ error: "Wallet accounts use Friendbot from the account menu." }, { status: 403 });
  }

  const { data: wallet } = await createSupabaseAdminClient()
    .from("smart_wallets")
    .select("address")
    .eq("user_id", user.id)
    .eq("network", NETWORK)
    .maybeSingle();
  if (!wallet) return Response.json({ error: "Create your passkey wallet first." }, { status: 409 });

  try {
    if ((await xlmBalanceStroops(wallet.address)) >= TOP_UP_BELOW_STROOPS) {
      return Response.json({ error: "Your wallet already has plenty of test XLM." }, { status: 409 });
    }
    const { hash, amountStroops } = await topUpWallet(wallet.address);
    return Response.json({ hash, amount: amountStroops.toString() });
  } catch (error) {
    if (error instanceof RelayRejection) return Response.json({ error: error.message }, { status: error.status });
    console.error("[chain/topup] unexpected error", error);
    return Response.json({ error: "The top-up failed. Try again." }, { status: 500 });
  }
}
