import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  isTauri,
  listCameras,
  onEngineError,
  onTelemetryFrame,
  setPreviewPose,
  startPreview,
  stopPreview,
  type CameraDescriptor,
  type PreviewStatus,
  type TelemetryFrame,
} from "../lib/ipc";

export interface UseTauriCaptureResult {
  frame: TelemetryFrame | null;
  /** Number of telemetry events received — proves the engine loop is alive. */
  telemetryFrames: number;
  status: PreviewStatus | null;
  cameras: CameraDescriptor[];
  engineError: string | null;
  busy: boolean;
  native: boolean;
  start: (deviceIndex?: number, poseId?: string) => Promise<void>;
  stop: () => Promise<void>;
  selectPose: (poseId: string) => Promise<void>;
  refreshCameras: () => Promise<void>;
}

/**
 * Owns the preview lifecycle and subscribes to the engine's 30 Hz telemetry
 * stream. Event subscriptions are torn down on unmount so hot reloads don't
 * leak listeners into the Tauri event bus.
 */
export function useTauriCapture(): UseTauriCaptureResult {
  const [frame, setFrame] = useState<TelemetryFrame | null>(null);
  const [telemetryFrames, setTelemetryFrames] = useState(0);
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [cameras, setCameras] = useState<CameraDescriptor[]>([]);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const native = isTauri();

  useEffect(() => {
    mounted.current = true;
    const subscriptions: Array<Promise<UnlistenFn>> = [
      onTelemetryFrame((payload) => {
        if (!mounted.current) return;
        setFrame(payload);
        setTelemetryFrames((count) => count + 1);
      }),
      onEngineError((message) => {
        if (mounted.current) setEngineError(message);
      }),
    ];

    // Surface registration failures instead of swallowing them: a denied
    // `listen` looks exactly like "the engine produces nothing".
    for (const subscription of subscriptions) {
      subscription.catch((error: unknown) => {
        if (mounted.current) {
          setEngineError(
            `Live telemetry unavailable: ${String(error)}. The overlay cannot update without it.`,
          );
        }
      });
    }

    return () => {
      mounted.current = false;
      for (const subscription of subscriptions) {
        subscription.then((unlisten) => unlisten()).catch(() => {});
      }
    };
  }, []);

  const refreshCameras = useCallback(async () => {
    if (!native) return;
    try {
      const devices = await listCameras();
      if (mounted.current) setCameras(devices);
    } catch (error) {
      if (mounted.current) setEngineError(String(error));
    }
  }, [native]);

  const start = useCallback(
    async (deviceIndex?: number, poseId?: string) => {
      setBusy(true);
      setEngineError(null);
      try {
        const next = await startPreview(deviceIndex, poseId);
        if (mounted.current) setStatus(next);
      } catch (error) {
        if (mounted.current) setEngineError(String(error));
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [],
  );

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      const next = await stopPreview();
      if (mounted.current) {
        setStatus(next);
        setFrame(null);
      }
    } catch (error) {
      if (mounted.current) setEngineError(String(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const selectPose = useCallback(async (poseId: string) => {
    try {
      await setPreviewPose(poseId);
    } catch (error) {
      if (mounted.current) setEngineError(String(error));
    }
  }, []);

  return {
    frame,
    telemetryFrames,
    status,
    cameras,
    engineError,
    busy,
    native,
    start,
    stop,
    selectPose,
    refreshCameras,
  };
}
