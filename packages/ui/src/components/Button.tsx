import * as React from "react";
import { Button as ShadcnButton } from "./ui/button";
import { cn } from "../lib/utils";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive";

export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders a spinner and blocks interaction. */
  loading?: boolean;
  fullWidth?: boolean;
}

/** Our historical variant names, mapped onto the shadcn variants. */
const VARIANT_MAP: Record<
  ButtonVariant,
  "default" | "secondary" | "outline" | "ghost" | "destructive"
> = {
  primary: "default",
  secondary: "secondary",
  outline: "outline",
  ghost: "ghost",
  destructive: "destructive",
};

const SIZE_MAP: Record<ButtonSize, "sm" | "default" | "lg"> = {
  sm: "sm",
  md: "default",
  lg: "lg",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      variant = "primary",
      size = "md",
      loading = false,
      fullWidth = false,
      disabled,
      children,
      type = "button",
      ...props
    },
    ref,
  ) {
    return (
      <ShadcnButton
        ref={ref}
        type={type}
        data-variant={variant}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(fullWidth && "w-full", className)}
        variant={VARIANT_MAP[variant]}
        size={SIZE_MAP[size]}
        {...props}
      >
        {loading && (
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        )}
        {children}
      </ShadcnButton>
    );
  },
);
