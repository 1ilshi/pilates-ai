/** The camera chosen in Settings, shared with the capture page.
 *
 * Stored locally so a clinician can pick an external webcam once and have it
 * used for every later preview/session, without re-picking it each time.
 */
const KEY = "pilates:selected-camera";

export function getSelectedCamera(): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 ? index : null;
  } catch {
    return null;
  }
}

export function setSelectedCamera(index: number | null): void {
  try {
    if (index === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(index));
  } catch {
    // A blocked storage API must not stop capture; the engine falls back to 0.
  }
}
