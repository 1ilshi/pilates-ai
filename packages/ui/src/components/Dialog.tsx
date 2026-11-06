import * as React from "react";
import { createPortal } from "react-dom";
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

let dialogSeq = 0;

/**
 * Accessible modal dialog: Escape closes, backdrop click closes, focus is moved
 * into the panel on open and restored to the previously focused element on
 * close, and background scroll is locked while open.
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
  const titleId = React.useMemo(() => `pilates-dialog-title-${++dialogSeq}`, []);
  const descriptionId = React.useMemo(
    () => `pilates-dialog-desc-${dialogSeq}`,
    [],
  );
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const previouslyFocused = React.useRef<HTMLElement | null>(null);

  // Keep the latest callback in a ref. `onClose` is usually an inline arrow
  // function, so depending on it directly would re-run the focus effect on
  // every parent render — stealing focus from an input on each keystroke.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    // Prefer the first *form* control so the caret lands in the first field.
    // The close button is deliberately last: it is the least useful target.
    const focusTarget = panelRef.current?.querySelector<HTMLElement>(
      "[data-autofocus], input, select, textarea, [href], button, [tabindex]:not([tabindex='-1'])",
    );
    (focusTarget ?? panelRef.current)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "relative w-full rounded-card border border-slate-800 bg-slate-900 p-6 shadow-2xl",
          "focus:outline-none",
          sizeClassName,
          className,
        )}
      >
        <div className="mb-4 pr-8">
          <h2 id={titleId} className="text-lg font-semibold text-slate-100">
            {title}
          </h2>
          {description && (
            <p id={descriptionId} className="mt-1 text-sm text-slate-400">
              {description}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute right-4 top-4 rounded-control p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>

        <div className="text-sm text-slate-300">{children}</div>

        {footer && (
          <div className="mt-6 flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
