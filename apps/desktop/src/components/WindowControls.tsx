import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@pilates/ui";

/**
 * The window ships with `decorations: false` so the title bar is drawn by the
 * app header and can use the app's own colours instead of the OS theme. This
 * component supplies the controls the native bar used to provide. It is only
 * rendered under Tauri — the plain-browser build has no window to control.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  // Track the maximized state so the middle button can show restore vs
  // maximize. `onResized` covers snap layouts, edge drags and programmatic
  // changes; the initial read covers a session restored already maximized.
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void appWindow.isMaximized().then((value) => {
      if (!cancelled) setMaximized(value);
    });
    void appWindow
      .onResized(() => {
        void appWindow.isMaximized().then((value) => {
          if (!cancelled) setMaximized(value);
        });
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const control =
    "inline-flex h-full w-11 items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50";

  return (
    // `-mr-4` reaches past the header padding so the buttons sit flush with
    // the window edge, like a native title bar. `relative` keeps the buttons
    // above the header's drag overlay.
    <div className="relative -mr-4 flex h-full items-stretch">
      <button
        type="button"
        title="Minimize"
        aria-label="Minimize window"
        className={control}
        onClick={() => void getCurrentWindow().minimize()}
      >
        <Minus className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore window size" : "Maximize window"}
        className={control}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        {maximized ? (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Square className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        title="Close"
        aria-label="Close window"
        className={cn(control, "hover:bg-red-500 hover:text-white")}
        onClick={() => void getCurrentWindow().close()}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
