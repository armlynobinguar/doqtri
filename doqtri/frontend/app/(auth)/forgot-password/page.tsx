import { AuthCard, AuthPage } from "@/components/auth/auth-card";
import { ForgotPasswordForm } from "@/components/auth/password-reset-forms";

export const metadata = { title: "Reset password · Doqtri" };

export default function ForgotPasswordPage() {
  return (
    <AuthPage>
      <AuthCard
        title="Reset your password"
        description="Enter the email you signed up with and we'll send you a reset link."
      >
        <ForgotPasswordForm />
      </AuthCard>
    </AuthPage>
  );
}
