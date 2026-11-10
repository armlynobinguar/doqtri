import Link from "next/link";
import { MINIMUM_AGE } from "@/lib/legal-copy";
import { cn } from "@/lib/utils";

export const PRIVACY_PATH = "/privacy";
export const TERMS_PATH = "/terms";

const LINK = "text-foreground underline underline-offset-2";

/**
 * Shown wherever an account can be created. The caller checks the gate
 * (lib/legal.ts): this renders whenever it is rendered.
 */
export function SignUpNotice({ className }: { className?: string }) {
  return (
    <p data-testid="sign-up-notice" className={cn("text-muted-foreground text-[11px] leading-relaxed", className)}>
      By creating an account you confirm you are {MINIMUM_AGE} or older, agree to the{" "}
      <Link href={TERMS_PATH} className={LINK}>
        Terms of Service
      </Link>{" "}
      and acknowledge the{" "}
      <Link href={PRIVACY_PATH} className={LINK}>
        Privacy Policy
      </Link>
      .
    </p>
  );
}

/** The two links on their own, for footers and settings. The caller checks the gate. */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-3 gap-y-1 [&_a]:underline-offset-2 [&_a:hover]:underline", className)}>
      <Link href={PRIVACY_PATH}>Privacy Policy</Link>
      <Link href={TERMS_PATH}>Terms of Service</Link>
    </span>
  );
}
