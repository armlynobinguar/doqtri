import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Brand status pill. Each tone is fixed by the brand system:
 * planned (neutral), verified (green), on-chain (purple), info (blue).
 */
const statusTagVariants = cva(
  "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        planned: "border-input bg-secondary text-muted-foreground",
        verified: "border-success/60 bg-success/10 text-success",
        onchain: "border-onchain/60 bg-onchain/10 text-onchain",
        info: "border-info/60 bg-info/10 text-info",
        warning: "border-warning/60 bg-warning/10 text-warning",
        danger: "border-destructive/60 bg-destructive/10 text-destructive",
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
