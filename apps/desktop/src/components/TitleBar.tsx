import { Logo } from "./Logo";
import { WindowControls } from "./WindowControls";

/**
 * Dedicated window title bar, replacing the native decorations (`decorations:
 * false`) so the top of the window uses the app's own palette. Everything on
 * the strip is either the drag surface itself or a window-control button —
 * unlike the tab bar below, no interactive content spans its width, so the
 * whole left and middle areas are always grabbable. Double-click toggles
 * maximize, matching the old native bar. Rendered only under Tauri; the
 * plain-browser build has no window to title.
 */
export function TitleBar() {
  return (
    <div data-tauri-drag-region className="flex h-8 shrink-0 items-stretch bg-sidebar">
      {/* `pointer-events-none` keeps the strip itself as the mousedown target
          even over the brand, so dragging works anywhere on the strip. */}
      <div className="pointer-events-none flex items-center gap-2 pl-3 text-xs font-medium text-muted-foreground">
        <Logo className="h-4 w-4" />
        Pilates AI Clinical Workstation
      </div>
      <WindowControls />
    </div>
  );
}
