import * as React from "react";
import { cn } from "../lib/utils";

export type BadgeVariant =
  | "neutral"
  | "brand"
  | "success"
  | "warning"
  | "danger"
  | "outline";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Renders a leading status dot, e.g. for live/sync indicators. */
  dot?: boolean;
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: "bg-secondary text-secondary-foreground border-border",
  brand: "bg-primary/15 text-primary border-primary/25",
  success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  danger: "bg-red-500/10 text-red-400 border-red-500/20",
  outline: "bg-transparent text-muted-foreground border-border",
};

const DOT_CLASSES: Record<BadgeVariant, string> = {
  neutral: "bg-slate-400",
  brand: "bg-brand-400",
  success: "bg-emerald-400",
  warning: "bg-amber-400",
  danger: "bg-red-400",
  outline: "bg-slate-400",
};

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  function Badge(
    { className, variant = "neutral", dot = false, children, ...props },
    ref,
  ) {
    return (
      <span
        ref={ref}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-0.5 text-xs font-mono uppercase tracking-wider",
          VARIANT_CLASSES[variant],
          className,
        )}
        {...props}
      >
        {dot && (
          <span
            aria-hidden="true"
            className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASSES[variant])}
          />
        )}
        {children}
      </span>
    );
  },
);
