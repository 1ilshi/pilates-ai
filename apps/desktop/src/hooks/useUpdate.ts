import { useCallback, useEffect, useRef, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "../lib/ipc";

/** The update object returned by the plugin, without importing its type. */
type PendingUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;

export interface UpdateState {
  version: string | null;
  notes: string | null;
  installing: boolean;
  error: string | null;
  /** Download and install the pending release, then restart into it. */
  install: () => Promise<void>;
  /** Hide the banner for this run without installing. */
  dismiss: () => void;
}

/**
 * Check for a newer desktop release.
 *
 * Deliberately check-only: nothing is downloaded or installed until the
 * clinician clicks. `enabled` is false during a capture session so an update
 * prompt can never interrupt a recording.
 */
export function useUpdate(enabled: boolean): UpdateState {
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const checked = useRef(false);

  useEffect(() => {
    if (!enabled || checked.current || !isTauri()) return;
    checked.current = true;

    let cancelled = false;
    // Let the app settle before touching the network.
    const timer = window.setTimeout(() => {
      check()
        .then((update) => {
          if (!cancelled && update) setPending(update);
        })
        .catch(() => {
          // A failed check is not worth a message: the clinic may simply be
          // offline, and the next launch will try again.
        });
    }, 4000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled]);

  const install = useCallback(async () => {
    if (!pending || installing) return;
    setInstalling(true);
    setError(null);
    try {
      await pending.downloadAndInstall();
      await relaunch();
    } catch (cause) {
      setError(String(cause));
      setInstalling(false);
    }
  }, [pending, installing]);

  const dismiss = useCallback(() => setDismissed(true), []);

  const visible = pending && !dismissed ? pending : null;

  return {
    version: visible?.version ?? null,
    notes: visible?.body ?? null,
    installing,
    error,
    install,
    dismiss,
  };
}
