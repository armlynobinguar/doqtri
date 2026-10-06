import { AuthCard, AuthPage } from "@/components/auth/auth-card";
import { EmailAuthForm } from "@/components/auth/email-auth-form";

export const metadata = { title: "Create account · Doqtri" };

export default function SignUpPage() {
  return (
    <AuthPage>
      <AuthCard
        title="Create your vault"
        description="Sign up with email. No wallet or extension needed to start writing."
      >
        <EmailAuthForm mode="sign-up" />
      </AuthCard>
    </AuthPage>
  );
}
