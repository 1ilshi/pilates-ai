import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-full text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive:
          "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border border-input bg-card shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/70",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-11 px-6 text-[0.9375rem] has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonVariant =
  | NonNullable<VariantProps<typeof buttonVariants>["variant"]>
  /** v2.0.12 alias, kept so older call sites stay styled and typed. */
  | "primary"
type ButtonSize =
  | NonNullable<VariantProps<typeof buttonVariants>["size"]>
  /** v2.0.12 alias. */
  | "md"

export interface ButtonProps extends React.ComponentProps<"button"> {
  variant?: ButtonVariant
  size?: ButtonSize
  asChild?: boolean
  /** Shows a spinner and blocks interaction while the action runs. */
  loading?: boolean
  /** v2.0.12 prop; preserved for call sites that still pass it. */
  fullWidth?: boolean
}

/** Resolves legacy variant/size names onto the current design tokens. */
function resolveVariant(variant: ButtonVariant) {
  return variant === "primary" ? "default" : variant
}

function resolveSize(size: ButtonSize) {
  return size === "md" ? "default" : size
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "default",
    size = "default",
    asChild = false,
    loading = false,
    fullWidth = false,
    type = "button",
    disabled,
    children,
    ...props
  },
  ref,
) {
  const Comp: React.ElementType = asChild ? Slot.Root : "button"
  const resolvedVariant = resolveVariant(variant)
  const resolvedSize = resolveSize(size)

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={resolvedVariant}
      data-size={resolvedSize}
      type={type}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(
        buttonVariants({ variant: resolvedVariant, size: resolvedSize }),
        fullWidth && "w-full",
        className,
      )}
      {...props}
    >
      {loading ? (
        <>
          <span
            aria-hidden="true"
            className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  )
})

export { Button, buttonVariants }
