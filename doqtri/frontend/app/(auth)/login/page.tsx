import { LoginForm } from "@/components/auth/login-form";
import { AuthPage } from "@/components/auth/auth-card";

export const metadata = { title: "Sign in · Doqtri" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { error } = await searchParams;
  return (
    <AuthPage>
      <LoginForm
        notice={
          error === "link"
            ? "That link is invalid or has expired. Sign in, or request a new one."
            : undefined
        }
      />
    </AuthPage>
  );
}
