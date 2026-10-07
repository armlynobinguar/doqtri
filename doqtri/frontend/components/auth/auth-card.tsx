import { DoqtriMark } from "@/components/brand/doqtri-mark";

/** The card every auth screen sits in: wordmark, display title, one line of context. */
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
    <div className="glass-float flex w-full max-w-[380px] flex-col gap-3 rounded-3xl p-7 sm:p-8">
      <div className="mb-4 flex items-center gap-2">
        <DoqtriMark className="text-foreground h-auto w-7 [--mark-fill:var(--brand-elevated)]" glow={false} title="" />
        <span className="text-[17px] font-extrabold tracking-[-0.045em]">doqtri</span>
      </div>
      <div className="mb-3 flex flex-col gap-2">
        <h1 className="display text-[28px] leading-[1.05]">{title}</h1>
        <p className="text-muted-foreground text-[13px] leading-relaxed">{description}</p>
      </div>
      {children}
    </div>
  );
}

/** Centers an auth card on a grained, top-lit field. */
export function AuthPage({ children }: { children: React.ReactNode }) {
  return (
    <main className="bg-grain relative flex min-h-svh items-center justify-center px-6 py-10">
      {/* A soft light behind the card, so the glass has something to catch. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_40%_at_50%_40%,rgb(220_220_242/0.07),transparent_70%)]"
      />
      <div className="relative flex w-full justify-center">{children}</div>
    </main>
  );
}
