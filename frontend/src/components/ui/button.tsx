import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  // Press feedback is scale(0.96) on transform only; never `transition-all`.
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-body font-medium whitespace-nowrap transition-[background-color,color,border-color,box-shadow,scale] duration-150 ease-(--ease-ui) outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.96] data-[static]:active:scale-100 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-danger aria-invalid:ring-danger/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-danger text-primary-foreground hover:bg-danger/90",
        outline:
          "border border-border bg-card text-foreground hover:bg-muted",
        // Tinted, not the theme's teal: white on teal fails contrast.
        secondary:
          "bg-primary-soft text-primary-soft-foreground hover:bg-primary-soft/70",
        ghost: "text-foreground hover:bg-muted",
        link: "text-primary underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        default: "h-10 px-4 has-[>svg]:px-3.5",
        xs: "h-7 gap-1 rounded-sm px-2.5 text-caption has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-9 gap-1.5 px-3.5 has-[>svg]:px-3",
        lg: "h-11 px-6 has-[>svg]:px-5",
        icon: "size-10",
        "icon-xs": "size-7 rounded-sm [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-9",
        "icon-lg": "size-11",
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
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
