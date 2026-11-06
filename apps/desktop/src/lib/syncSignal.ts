/**
 * Ask the background sync to run now.
 *
 * Dispatched after a local write so the clinician's own work reaches Firestore
 * immediately instead of waiting for the next scheduled sweep. The listener
 * debounces, so calling this on every keystroke is safe.
 */
export function signalSync(): void {
  window.dispatchEvent(new Event("pilates:sync-now"));
}
