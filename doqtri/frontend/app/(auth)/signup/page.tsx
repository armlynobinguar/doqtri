import { cookies } from "next/headers";
import { AuthCard, AuthPage, AuthSwitch } from "@/components/auth/auth-card";
import { EmailAuthForm } from "@/components/auth/email-auth-form";
import { ReferralCodeField } from "@/components/auth/referral-code-field";
import { WalletOption } from "@/components/auth/wallet-option";
import { safeNextPath, withNext } from "@/lib/email-auth";
import { readReferralCookie, REFERRAL_COOKIE } from "@/lib/referral";

export const metadata = { title: "Create account · Doqtri" };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  // Came through a referral link or QR code: show the code it carried.
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const referral = secret ? readReferralCookie((await cookies()).get(REFERRAL_COOKIE)?.value, secret) : null;
  return (
    <AuthPage>
      <AuthCard
        title="Create your vault"
        description="Sign up with email. No wallet or extension needed to start writing."
      >
        <EmailAuthForm mode="sign-up" next={next} />
        <WalletOption next={next} />
        <ReferralCodeField initialCode={referral?.code ?? null} />
        <AuthSwitch prompt="Already have an account?" href={withNext("/login", next)} label="Sign in" />
      </AuthCard>
    </AuthPage>
  );
}
