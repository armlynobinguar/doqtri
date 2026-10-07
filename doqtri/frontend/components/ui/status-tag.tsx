import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Brand status pill: a monochrome glass capsule. The tone never fills the
 * pill — it shows only as a small leading dot, or as the tint of the pill's
 * own icon when it has one. Tones: planned (neutral), verified (green),
 * on-chain (lavender), info, warning, danger.
 */
const statusTagVariants = cva(
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--glass-lo)] bg-[var(--glass)] px-2.5 py-1 text-[11px] leading-none font-medium whitespace-nowrap text-foreground/85 shadow-[inset_0_1px_0_0_var(--glass-hi)] before:size-1.5 before:shrink-0 before:rounded-full before:bg-(--tag-tone) before:shadow-[0_0_6px_var(--tag-tone)] has-[svg]:before:hidden [&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:text-(--tag-tone)",
  {
    variants: {
      tone: {
        planned: "text-muted-foreground [--tag-tone:var(--label)] before:shadow-none",
        verified: "[--tag-tone:var(--success)]",
        onchain: "[--tag-tone:var(--onchain)]",
        info: "[--tag-tone:var(--info)]",
        warning: "[--tag-tone:var(--warning)]",
        danger: "[--tag-tone:var(--destructive)]",
      },
    },
    defaultVariants: {
      tone: "planned",
    },
  }
)

function StatusTag({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof statusTagVariants>) {
  return (
    <span
      data-slot="status-tag"
      className={cn(statusTagVariants({ tone, className }))}
      {...props}
    />
  )
}

export { StatusTag, statusTagVariants }
