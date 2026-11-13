import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "../lib/ipc";

/** The update object returned by the plugin, without importing its type. */
type PendingUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;

export interface UpdateState {
  /** Version currently installed, when the bundle reports it. */
  currentVersion: string | null;
  /** Version offered by the update manifest, or null when none is pending. */
  version: string | null;
  notes: string | null;
  installing: boolean;
  /** 0-1 while downloading, or null when the server sent no length. */
  progress: number | null;
  error: string | null;
  checking: boolean;
  /** True for a few seconds after a manual check finds nothing. */
  upToDate: boolean;
  install: () => Promise<void>;
  dismiss: () => void;
  /** Check now, on the user's click. */
  checkNow: () => Promise<void>;
}

/**
 * Check for a newer desktop release.
 *
 * Deliberately check-only: nothing is downloaded or installed until the
 * clinician clicks. `enabled` is false during a capture session so an update
 * prompt can never interrupt a recording.
 */
export function useUpdate(enabled: boolean): UpdateState {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [upToDate, setUpToDate] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const checked = useRef(false);
  const upToDateTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    getVersion()
      .then(setCurrentVersion)
      .catch(() => setCurrentVersion(null));
  }, []);

  const runCheck = useCallback(async (silent: boolean) => {
    if (!isTauri()) return;
    if (upToDateTimer.current !== null) {
      window.clearTimeout(upToDateTimer.current);
      upToDateTimer.current = null;
    }
    if (!silent) {
      setChecking(true);
      setError(null);
      setUpToDate(false);
    }

    try {
      const update = await check();
      if (update) {
        setPending(update);
        // A manual check should surface the banner even if it was dismissed.
        setDismissed(false);
      } else if (!silent) {
        setUpToDate(true);
        upToDateTimer.current = window.setTimeout(() => {
          upToDateTimer.current = null;
          setUpToDate(false);
        }, 6000);
      }
    } catch (cause) {
      if (!silent) setError(String(cause));
    } finally {
      if (!silent) setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || checked.current) return;
    // Let the app settle before touching the network. Mark the check as done
    // only when it actually fires, so leaving the capture tab re-schedules it.
    const timer = window.setTimeout(() => {
      checked.current = true;
      void runCheck(true);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [enabled, runCheck]);

  const checkNow = useCallback(async () => {
    if (!enabled) return;
    await runCheck(false);
  }, [enabled, runCheck]);

  const install = useCallback(async () => {
    if (!pending || installing) return;
    setInstalling(true);
    setError(null);
    setProgress(0);
    try {
      let total = 0;
      let downloaded = 0;
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          downloaded = 0;
          setProgress(total > 0 ? 0 : null);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength ?? 0;
          setProgress(total > 0 ? Math.min(1, downloaded / total) : null);
        } else if (event.event === "Finished") {
          setProgress(1);
        }
      });
      await relaunch();
    } catch (cause) {
      setError(String(cause));
      setInstalling(false);
      setProgress(null);
    }
  }, [pending, installing]);

  const dismiss = useCallback(() => setDismissed(true), []);

  const visible = pending && !dismissed ? pending : null;

  return {
    currentVersion,
    version: visible?.version ?? null,
    notes: visible?.body ?? null,
    installing,
    progress,
    error,
    checking,
    upToDate,
    install,
    dismiss,
    checkNow,
  };
}
