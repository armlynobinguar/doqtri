import Link from "next/link";
import { MailIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  className?: string;
  size?: "default" | "lg" | "sm";
  label?: string;
};

/** The glass companion to ConnectWalletButton: same size, sends to /login. */
export function EmailSignInLink({
  className,
  size = "default",
  label = "Sign in with email",
}: Props) {
  return (
    <Link
      href="/login"
      className={cn(buttonVariants({ variant: "outline", size }), className)}
    >
      <MailIcon />
      {label}
    </Link>
  );
}
