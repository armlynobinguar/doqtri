import { LoginForm } from "@/components/auth/login-form";

export const metadata = { title: "Sign in · Mindmap" };

export default function LoginPage() {
  return (
    <main className="flex h-full items-center justify-center px-6">
      <LoginForm />
    </main>
  );
}
