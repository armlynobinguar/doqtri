import { LoginForm } from "@/components/auth/login-form";

export const metadata = { title: "Connect wallet · Doqtri" };

export default function LoginPage() {
  return (
    <main className="bg-grid flex min-h-svh items-center justify-center px-6">
      <LoginForm />
    </main>
  );
}
