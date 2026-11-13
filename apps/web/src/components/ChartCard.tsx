import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, Maximize2 } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, cn } from "@pilates/ui";

export interface ChartCardProps {
  title: string;
  description?: string;
  /** Called when the maximise control is pressed. */
  onExpand: () => void;
  /** Optional control rendered beside the maximise button, e.g. a selector. */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** A chart card with a control to open it full-page. */
export function ChartCard({
  title,
  description,
  onExpand,
  action,
  className,
  children,
}: ChartCardProps) {
  return (
    <Card className={cn("min-w-0", className)}>
      <CardHeader className="pb-0">
        {/* The control group is wide; letting the header wrap keeps the title
            readable instead of collapsing it to one word per line. */}
        <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1.5">
          <div className="min-w-0 flex-1 basis-40">
            <CardTitle className="text-sm">{title}</CardTitle>
            {description && (
              <p className="mt-1 text-xs text-slate-500">{description}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {action}
            <button
              type="button"
              onClick={onExpand}
              aria-label={`Expand ${title}`}
              className="rounded-control p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
            >
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4">{children}</CardContent>
    </Card>
  );
}

export interface ChartOverlayProps {
  title: string;
  onClose: () => void;
  /** Same controls the card shows, so the expanded view stays interactive. */
  actions?: ReactNode;
  children: ReactNode;
}

/** Full-page chart view. Escape or the back button returns to the page. */
export function ChartOverlay({ title, onClose, actions, children }: ChartOverlayProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={onClose}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          {actions}
          <h3 className="truncate text-sm font-semibold text-slate-200">{title}</h3>
        </div>
      </div>
      <div className="flex-1 overflow-auto rounded-card border border-slate-800 bg-slate-900/40 p-3 sm:p-6">
        {children}
      </div>
    </div>
  );
}

/** Tracks which chart is expanded; the page renders the overlay. */
export function useExpandedChart() {
  const [expanded, setExpanded] = useState<string | null>(null);
  return {
    expanded,
    expand: (id: string) => setExpanded(id),
    collapse: () => setExpanded(null),
  };
}
