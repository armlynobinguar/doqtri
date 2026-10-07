import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[10px] border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Brand primary: the one bright fill on a screen — a pale pearl pill
        // with dark ink and a soft halo.
        default:
          "bg-primary text-primary-foreground font-semibold shadow-[inset_0_1px_0_0_rgb(255_255_255/0.6),0_0_0_1px_rgb(255_255_255/0.08),0_6px_20px_-6px_color-mix(in_oklch,var(--primary),transparent_55%)] hover:bg-[color-mix(in_oklch,var(--primary),white_18%)] hover:shadow-[inset_0_1px_0_0_rgb(255_255_255/0.6),0_0_0_1px_rgb(255_255_255/0.12),0_8px_28px_-6px_color-mix(in_oklch,var(--primary),transparent_40%)]",
        // Glass: the default secondary surface.
        outline:
          "border-[var(--glass-lo)] bg-[var(--glass)] text-foreground shadow-[inset_0_1px_0_0_var(--glass-hi)] hover:border-[var(--glass-hi)] hover:bg-[var(--glass-strong)] aria-expanded:border-[var(--glass-hi)] aria-expanded:bg-[var(--glass-strong)]",
        secondary:
          "border-[var(--glass-lo)] bg-[var(--glass-strong)] text-secondary-foreground shadow-[inset_0_1px_0_0_var(--glass-hi)] hover:border-[var(--glass-hi)] hover:bg-[color-mix(in_oklch,white_10%,transparent)] aria-expanded:bg-[color-mix(in_oklch,white_10%,transparent)]",
        ghost:
          "text-muted-foreground hover:bg-[var(--glass-strong)] hover:text-foreground aria-expanded:bg-[var(--glass-strong)] aria-expanded:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-2 px-4 text-[15px] has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
