import { Download } from "lucide-react";
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
 * because a restart mid-session would lose a recording. The strip shows the
 * version transition, the release notes and download progress, so a clinician
 * knows what will change before restarting.
 */
export function UpdateBanner({ update, className }: UpdateBannerProps) {
  if (!update.version) return null;

  const percent =
    update.progress === null ? null : Math.round(update.progress * 100);

  return (
    <div
      className={cn(
        "border-b border-brand-500/30 bg-brand-500/10 px-4 py-3 text-xs text-slate-200 sm:px-6",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 shrink-0 rounded-control bg-brand-500/15 p-1.5 text-brand-400">
            <Download className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-100">
              Update available
              <span className="ml-1.5 font-normal text-slate-400">
                {update.currentVersion
                  ? `${update.currentVersion} → ${update.version}`
                  : `v${update.version}`}
              </span>
            </p>

            {update.notes ? (
              <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-line text-slate-400">
                {update.notes}
              </p>
            ) : (
              <p className="mt-1 text-slate-400">
                A newer workstation build is ready to install.
              </p>
            )}

            {update.installing && (
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 w-44 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-brand-400 transition-all"
                    style={{ width: `${percent ?? 10}%` }}
                  />
                </div>
                <span className="text-slate-400">
                  {percent !== null ? `${percent}%` : "Downloading…"}
                </span>
              </div>
            )}

            {update.error && (
              <p className="mt-1 text-rose-300" title={update.error}>
                Update failed — {update.error}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:ml-4">
          <Button
            size="sm"
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
        </div>
      </div>
    </div>
  );
}
