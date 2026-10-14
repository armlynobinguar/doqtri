"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { LockKeyholeOpenIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { withNext } from "@/lib/email-auth";
import { isReturningVisitor } from "@/lib/returning-visitor";
import { cn } from "@/lib/utils";

type Props = {
  className?: string;
  size?: "default" | "lg" | "sm";
  label?: string;
  /** Same-site path to open once signed in. */
  next?: string;
};

/**
 * The one way in from marketing pages. New visitors land on sign-up, returning
 * ones on sign-in; both screens offer the wallet as a quieter second option.
 */
export function OpenVaultLink({ className, size = "default", label = "Open vault", next = "/vault" }: Props) {
  // localStorage is browser-only, so the server render always says /signup.
  const returning = useSyncExternalStore(noSubscription, isReturningVisitor, () => false);

  return (
    <Link href={withNext(returning ? "/login" : "/signup", next)} className={cn(buttonVariants({ size }), className)}>
      <LockKeyholeOpenIcon strokeWidth={1.5} />
      {label}
    </Link>
  );
}

/** The flag only changes on the auth screens, never while this link is mounted. */
function noSubscription() {
  return () => {};
}
