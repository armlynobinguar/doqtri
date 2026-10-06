import { AuthCard, AuthPage } from "@/components/auth/auth-card";
import { ResetPasswordForm } from "@/components/auth/password-reset-forms";

export const metadata = { title: "Choose a new password · Doqtri" };

/** Reached signed in, through the emailed link and /auth/confirm (proxy.ts). */
export default function ResetPasswordPage() {
  return (
    <AuthPage>
      <AuthCard title="Choose a new password" description="You're signed in from the reset link. Set a new password to finish.">
        <ResetPasswordForm />
      </AuthCard>
    </AuthPage>
  );
}
