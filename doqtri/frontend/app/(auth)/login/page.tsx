import { LoginForm } from "@/components/auth/login-form";
import { AuthPage } from "@/components/auth/auth-card";
import { safeNextPath } from "@/lib/email-auth";
import { legalPagesLive } from "@/lib/legal";

export const metadata = { title: "Sign in · Doqtri" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { error, next } = await searchParams;
  return (
    <AuthPage>
      <LoginForm
        legalLive={legalPagesLive()}
        next={safeNextPath(typeof next === "string" ? next : null)}
        notice={
          error === "link"
            ? "That link is invalid or has expired. Sign in, or request a new one."
            : undefined
        }
      />
    </AuthPage>
  );
}
