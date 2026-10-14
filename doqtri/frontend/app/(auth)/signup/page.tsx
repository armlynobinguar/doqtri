import { AuthCard, AuthPage, AuthSwitch } from "@/components/auth/auth-card";
import { EmailAuthForm } from "@/components/auth/email-auth-form";
import { WalletOption } from "@/components/auth/wallet-option";
import { safeNextPath, withNext } from "@/lib/email-auth";

export const metadata = { title: "Create account · Doqtri" };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  return (
    <AuthPage>
      <AuthCard
        title="Create your vault"
        description="Sign up with email. No wallet or extension needed to start writing."
      >
        <EmailAuthForm mode="sign-up" next={next} />
        <WalletOption next={next} />
        <AuthSwitch prompt="Already have an account?" href={withNext("/login", next)} label="Sign in" />
      </AuthCard>
    </AuthPage>
  );
}
