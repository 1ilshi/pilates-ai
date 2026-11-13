import { useEffect, useRef, useState } from "react";
import { isTauri, syncCheckRemote, syncNow, syncPullPatients } from "../lib/ipc";

/** Safety-net sweep: uploads pending work and pulls the roster. */
const FULL_INTERVAL_MS = 60_000;
/** How often the tiny change marker is consulted. */
const MARKER_INTERVAL_MS = 10_000;
/** Coalesces a burst of local writes into one upload. */
const CHANGE_DEBOUNCE_MS = 2_000;

export interface AutoSyncStatus {
  /** When the last fully successful run finished, if ever. */
  lastSyncAt: number | null;
  /** Last failure, or `null` when the previous run succeeded. */
  lastError: string | null;
  syncing: boolean;
  /** True when the stored sign-in was refused; only signing in again fixes it. */
  authRejected: boolean;
}

/**
 * Keeps this workstation in step with Firestore.
 *
 * Three triggers, in order of how quickly they act:
 * - **Local writes** dispatch `pilates:sync-now`, uploaded after a short
 *   debounce so the clinician's own work reaches the cloud immediately.
 * - **The change marker** is polled every ten seconds; when it reports a
 *   revision this workstation did not write, a pull follows.
 * - **A one-minute sweep** still runs as the safety net, covering missed
 *   events, offline gaps and a marker that was never deployed.
 */
export function useAutoSync(): AutoSyncStatus {
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [authRejected, setAuthRejected] = useState(false);
  const running = useRef(false);
  const debounce = useRef<number | null>(null);

  useEffect(() => {
    if (!isTauri()) return;

    let stopped = false;

    const run = async (pull: boolean) => {
      if (stopped || running.current) return;
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        if (!stopped) setLastError("offline");
        return;
      }

      running.current = true;
      if (!stopped) setSyncing(true);

      let failure: string | null = null;
      let rejected = false;
      // Upload and download are attempted independently: a failed upload must
      // not prevent new sessions from arriving.
      try {
        // The report matters: `flush` records per-session failures inside it
        // and still resolves. Treating a resolved promise as success made the
        // sidebar say "Synced just now" while every upload was failing.
        const report = await syncNow();
        if (report.auth_rejected) {
          // The credential itself was refused. There is nothing to retry until
          // the user signs in, and the banner must not flicker between runs.
          rejected = true;
          failure =
            report.errors[0] ??
            "This workstation's sign-in was rejected. Sign in again to resume syncing.";
        } else if (!report.enabled) {
          failure = "cloud sync is not configured";
        } else if (report.failed > 0) {
          failure =
            report.errors[0] ?? `${report.failed} session(s) could not be uploaded`;
        } else if (report.conflicts > 0) {
          failure =
            report.conflicts === 1
              ? "a patient edit was refused: another workstation changed it first"
              : `${report.conflicts} patient edits were refused: another workstation changed them first`;
        }
      } catch (error) {
        failure = String(error);
        rejected = failure.startsWith("auth:");
      }
      if (pull && !rejected) {
        try {
          const pulled = await syncPullPatients();
          if (!failure && pulled && !pulled.enabled) {
            failure = "cloud sync is not configured";
          } else if (!failure && pulled?.error) {
            // Sessions recorded on another workstation never arrived. Saying
            // "synced" here would hide a real gap in the patient's history.
            failure = pulled.error;
            rejected = failure.startsWith("auth:");
          }
        } catch (error) {
          failure = failure ?? String(error);
        }
      }

      running.current = false;
      if (stopped) return;
      setSyncing(false);
      setLastError(failure);
      setAuthRejected(rejected);
      if (!failure) {
        setLastSyncAt(Date.now());
        // The pages have no manual refresh any more, so tell them to reload.
        window.dispatchEvent(new Event("pilates:data-changed"));
      }
    };

    /** Cheap check: has anyone else changed the clinic? */
    const checkMarker = async () => {
      if (stopped || running.current) return;
      try {
        if (await syncCheckRemote()) {
          await run(true);
        }
      } catch {
        // A marker failure is not worth surfacing: the sweep covers it.
      }
    };

    const onLocalChange = () => {
      if (debounce.current !== null) window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(() => {
        debounce.current = null;
        void run(true);
      }, CHANGE_DEBOUNCE_MS);
    };

    void run(true);

    const fullTimer = window.setInterval(() => void run(true), FULL_INTERVAL_MS);
    const markerTimer = window.setInterval(() => void checkMarker(), MARKER_INTERVAL_MS);
    const onOnline = () => void run(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("pilates:sync-now", onLocalChange);

    return () => {
      stopped = true;
      window.clearInterval(fullTimer);
      window.clearInterval(markerTimer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pilates:sync-now", onLocalChange);
      if (debounce.current !== null) window.clearTimeout(debounce.current);
    };
  }, []);

  return { lastSyncAt, lastError, syncing, authRejected };
}
