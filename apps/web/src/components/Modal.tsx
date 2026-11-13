import { useEffect, useRef, type ReactNode } from "react";

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Dialog shell with a backdrop, Escape handling and focus containment.
 *
 * The keydown effect deliberately depends on `open` only and reaches the close
 * callback through a ref. Depending on the callback itself re-registers the
 * listener on every parent render, which previously stole focus from the input
 * on each keystroke.
 */
export function Modal({ open, title, onClose, children, footer }: ModalProps) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };

    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
        onClick={() => closeRef.current()}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-card border border-slate-700 bg-slate-900 shadow-xl"
      >
        <div className="border-b border-slate-800 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
