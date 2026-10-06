import { DoqtriMark } from "@/components/brand/doqtri-mark";

/** The card every auth screen sits in: mark, title, one line of context. */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card flex w-full max-w-[360px] flex-col gap-3 rounded-xl border p-7 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)]">
      <DoqtriMark className="mb-2 h-auto w-14 text-foreground [--mark-fill:var(--brand-elevated)]" />
      <div className="mb-3 flex flex-col gap-1.5">
        <h1 className="text-lg font-bold tracking-tight">{title}</h1>
        <p className="text-muted-foreground text-[13px] leading-relaxed">{description}</p>
      </div>
      {children}
    </div>
  );
}

/** Centers an auth card on the grid background, like /login always has. */
export function AuthPage({ children }: { children: React.ReactNode }) {
  return <main className="bg-grid flex min-h-svh items-center justify-center px-6">{children}</main>;
}
