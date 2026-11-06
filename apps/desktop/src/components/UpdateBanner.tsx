import { Button, cn } from "@pilates/ui";
import type { UpdateState } from "../hooks/useUpdate";

interface UpdateBannerProps {
  update: UpdateState;
  className?: string;
}

/**
 * "A newer version is available" strip.
 *
 * Installing is always a click: the desktop never replaces itself silently,
 * because a restart mid-session would lose a recording.
 */
export function UpdateBanner({ update, className }: UpdateBannerProps) {
  if (!update.version) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 border-b border-teal-500/30 bg-teal-500/10 px-4 py-2 text-xs text-teal-100",
        className,
      )}
      role="status"
    >
      <span className="font-medium">
        Version {update.version} is available.
      </span>
      {update.notes ? (
        <span className="max-w-xl truncate text-teal-200/70" title={update.notes}>
          {update.notes}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-2">
        {update.error ? (
          <span className="text-rose-300" title={update.error}>
            Update failed
          </span>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void update.install()}
          disabled={update.installing}
        >
          {update.installing ? "Installing…" : "Install and restart"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={update.dismiss}
          disabled={update.installing}
        >
          Later
        </Button>
      </span>
    </div>
  );
}
