import * as React from "react";
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { cn } from "../lib/utils";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** Tailwind max-width class for the panel. */
  sizeClassName?: string;
  className?: string;
}

/**
 * Accessible modal dialog backed by Radix: Escape closes, backdrop click
 * closes, focus is trapped and moved into the panel on open and restored to
 * the previously focused element on close, and background scroll is locked
 * while open. (These guarantees previously came from a hand-rolled
 * implementation; Radix provides them now.)
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  sizeClassName = "max-w-lg",
  className,
}: DialogProps) {
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* `sm:max-w-none` releases the shadcn default so `sizeClassName` rules
          at every breakpoint; twMerge drops the base calc() cap in favour of
          the caller's max-width, and `w-full` keeps phones honest. */}
      <DialogContent className={cn("sm:max-w-none", sizeClassName, className)}>
        <DialogHeader>
          <DialogTitle className="font-mono">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="text-sm text-foreground">{children}</div>

        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </DialogRoot>
  );
}
