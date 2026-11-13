import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Square, Play, Volume2, VolumeX } from "lucide-react";
import { JointAngleGauge, type DetectionBox } from "@pilates/viz";
import type { Keypoint2D, PoseId } from "@pilates/types";
import { poseDisplayLabel } from "@pilates/types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  formatPercent,
} from "@pilates/ui";
import { LivePreview } from "../components/LivePreview";
import { useTauriCapture } from "../hooks/useTauriCapture";
import { signalSync } from "../lib/syncSignal";
import {
  captureStatus,
  engineStatus,
  isTauri,
  startSession,
  stopSession,
  type CaptureStatus,
  type EngineStatus,
  type PatientRecord,
  type PoseSummary,
} from "../lib/ipc";

export interface ActiveCapturePageProps {
  patient: PatientRecord | null;
  onSessionComplete: (document: Record<string, unknown>) => void;
}

const PHASE_TONE: Record<string, string> = {
  idle: "neutral",
  start_position: "neutral",
  eccentric: "brand",
  concentric: "warning",
  holding: "success",
  rep_completed: "success",
} as const;

export function ActiveCapturePage({ patient, onSessionComplete }: ActiveCapturePageProps) {
  const native = isTauri();
  const {
    frame,
    telemetryFrames,
    status,
    cameras,
    engineError,
    busy,
    start,
    stop,
    selectPose,
    refreshCameras,
  } = useTauriCapture();

  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [poseId, setPoseId] = useState<string>("pose1");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [capture, setCapture] = useState<CaptureStatus | null>(null);

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await captureStatus();
        if (!cancelled) setCapture(status);
      } catch {
        // Diagnostics are best-effort; never surface a polling error.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [native]);

  const audioRef = useRef<AudioContext | null>(null);
  const lastRepRef = useRef(0);

  useEffect(() => {
    if (!native) return;
    engineStatus()
      .then(setEngine)
      .catch((error) => setSessionError(String(error)));
    void refreshCameras();
  }, [native, refreshCameras]);

  const poses: PoseSummary[] = useMemo(() => engine?.poses ?? [], [engine]);

  /** Short two-tone chime when a repetition completes. */
  const chime = useCallback(() => {
    if (muted) return;
    try {
      audioRef.current ??= new AudioContext();
      const context = audioRef.current;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, context.currentTime);
      oscillator.frequency.setValueAtTime(1320, context.currentTime + 0.09);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.15, context.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.25);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.26);
    } catch {
      // Audio is a nicety; never let it break the capture flow.
    }
  }, [muted]);

  useEffect(() => {
    if (!frame) return;
    if (frame.rep_count > lastRepRef.current) {
      lastRepRef.current = frame.rep_count;
      chime();
    }
  }, [frame, chime]);

  const keypoints: Keypoint2D[] = useMemo(
    () =>
      (frame?.keypoints ?? []).map((keypoint) => ({
        id: keypoint.id,
        label: keypoint.label,
        x: keypoint.x,
        y: keypoint.y,
        confidence: keypoint.confidence,
      })),
    [frame],
  );

  const detections = useMemo<DetectionBox[]>(() => {
    const fromModel = (frame?.detections ?? []).map((detection) => ({
      bbox: detection.bbox,
      classId: detection.class_id,
      confidence: detection.confidence,
      label: detection.label,
    }));
    if (fromModel.length > 0) return fromModel;

    // Fallback: if the backend did not supply boxes (older payload), outline
    // the keypoint extent so the overlay is never silently blank. Labelled
    // "pose" to distinguish it from a real model box.
    const points = frame?.keypoints ?? [];
    if (points.length < 2) return [];
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const pad = 0.04;
    return [
      {
        bbox: [
          Math.max(0, Math.min(...xs) - pad),
          Math.max(0, Math.min(...ys) - pad),
          Math.min(1, Math.max(...xs) + pad),
          Math.min(1, Math.max(...ys) + pad),
        ] as [number, number, number, number],
        classId: -1,
        confidence: Math.min(1, Math.max(0, frame?.best_class_score ?? 0)),
        label: "pose",
      },
    ];
  }, [frame]);

  const beginSession = async () => {
    if (!patient) {
      setSessionError("Select a patient before starting a session.");
      return;
    }
    setSessionError(null);
    try {
      const id = await startSession(patient.id, poseId);
      setSessionId(id);
      lastRepRef.current = 0;
      await start(undefined, poseId);
    } catch (error) {
      setSessionError(String(error));
    }
  };

  const endSession = async () => {
    setFinishing(true);
    setSessionError(null);
    try {
      const document = await stopSession();
      signalSync();
      onSessionComplete(document);
    } catch (error) {
      setSessionError(String(error));
    } finally {
      // Always release the camera. Previously a failed save skipped this,
      // leaving a live preview the user could not shut down.
      setSessionId(null);
      await stop();
      setFinishing(false);
    }
  };

  const running = Boolean(status?.running);
  const phase = frame?.phase ?? "idle";

  return (
    <div className="space-y-5">
      {!native && (
        <Card className="border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-300">
          Browser preview mode — the Rust capture engine is only available inside
          Tauri.
        </Card>
      )}

      {(engineError || sessionError) && (
        <Card className="border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">
          {sessionError ?? engineError}
        </Card>
      )}

      {capture?.camera_error && (
        <Card className="border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-200">
          The camera stopped delivering frames — {capture.camera_error}. The preview
          is showing its last image, so anything recorded now is not from the camera.
          Check the connection, then stop and start the preview.
        </Card>
      )}

      {capture?.preview_running && !capture.engine_available && (
        <Card className="border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-300">
          Pose detection has not loaded — {engine?.detail ?? "unknown error"}. Recording
          still works, but no skeleton or repetitions will be detected.
        </Card>
      )}

      {engine && !engine.bucket_configured && (
        <Card className="border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-300">
          Archive upload is disabled — no telemetry bucket is configured. Sessions are
          recorded and queued on this computer, but the portal will show no charts for
          them until{" "}
          <code className="rounded bg-slate-950/60 px-1 py-0.5 font-mono text-[11px]">
            bucket
          </code>{" "}
          is set in{" "}
          <code className="rounded bg-slate-950/60 px-1 py-0.5 font-mono text-[11px]">
            cloud.json
          </code>{" "}
          (or{" "}
          <code className="rounded bg-slate-950/60 px-1 py-0.5 font-mono text-[11px]">
            PILATES_FIREBASE_BUCKET
          </code>{" "}
          is set for this installation).
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* Video + skeleton */}
        <div className="lg:col-span-2 space-y-3">
          <Card className="relative overflow-hidden p-3">
            <LivePreview
              running={running}
              keypoints={keypoints}
              detections={detections}
              poseId={poseId as PoseId}
              showAngles
            />
            <div className="pointer-events-none absolute left-2 top-2 rounded bg-slate-950/80 px-2 py-1 font-mono text-[10px] leading-tight text-slate-300">
              det {frame?.detections?.length ?? 0} · kp {keypoints.length} · ev{" "}
              {telemetryFrames}
            </div>
          </Card>

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <Badge variant={running ? "success" : "neutral"} dot>
              {running ? "Live" : "Idle"}
            </Badge>
            {status?.device && (
              <span className="inline-flex items-center gap-1">
                <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                {status.device.human_name}
              </span>
            )}
            <span>
              Engine:{" "}
              {capture ? (capture.engine_available ? "ready" : "not loaded") : "…"}
            </span>
            {frame && (
              <span
                className={
                  frame.detections.length > 0 ? "font-medium text-emerald-400" : undefined
                }
              >
                Detections: {frame.detections.length}
              </span>
            )}
            {frame && (
              <span
                title="Strongest class score in the frame, even when below the drawing threshold"
                className={
                  frame.best_class_score >= 0.25
                    ? "text-emerald-400"
                    : frame.best_class_score >= 0.1
                      ? "text-amber-400"
                      : "text-slate-500"
                }
              >
                Model: {frame.best_class_label || "—"} {frame.best_class_score.toFixed(2)}
              </span>
            )}
            {frame && <span>{frame.inference_ms.toFixed(0)} ms</span>}
            <span className={telemetryFrames === 0 ? "text-amber-400" : "text-slate-500"}>
              Events: {telemetryFrames}
            </span>
            {frame && <span>Frame {frame.frame_index}</span>}
            {capture && (
              <span
                className={
                  capture.session_active && capture.session_frames === 0
                    ? "font-medium text-amber-400"
                    : undefined
                }
              >
                Camera {capture.camera_frames} · Recorded {capture.session_frames}
              </span>
            )}
          </div>
        </div>

        {/* Clinical panel */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>Session</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-sm text-slate-400">
                Patient:{" "}
                <span className="font-medium text-slate-200">
                  {patient?.name ?? "none selected"}
                </span>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-400">Pose</span>
                <select
                  value={poseId}
                  onChange={(event) => {
                    setPoseId(event.target.value);
                    void selectPose(event.target.value);
                  }}
                  className="h-9 w-full rounded-control border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none"
                >
                  {(poses.length
                    ? poses
                    : [{ pose_id: "pose1", display_name: "Pose 1" } as PoseSummary]
                  ).map((pose) => (
                    <option key={pose.pose_id} value={pose.pose_id}>
                      {poseDisplayLabel(pose.pose_id)}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-2">
                {!sessionId ? (
                  <Button
                    onClick={() => void beginSession()}
                    disabled={!native || busy || !patient}
                    fullWidth
                  >
                    <Play className="h-4 w-4" aria-hidden="true" />
                    Start
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    onClick={() => void endSession()}
                    loading={finishing}
                    fullWidth
                    className="col-span-2 h-12 text-base"
                  >
                    <Square className="h-4 w-4" aria-hidden="true" />
                    Stop &amp; save
                  </Button>
                )}

                {!sessionId && (
                  <Button
                    variant="outline"
                    onClick={() => void (running ? stop() : start(undefined, poseId))}
                    disabled={!native || busy}
                    fullWidth
                  >
                    {running ? "Stop preview" : "Preview"}
                  </Button>
                )}
              </div>

              <button
                type="button"
                onClick={() => setMuted((value) => !value)}
                className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200"
              >
                {muted ? (
                  <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {muted ? "Chime muted" : "Chime on rep completion"}
              </button>

              {cameras.length > 1 && (
                <p className="text-xs text-slate-500">
                  {cameras.length} cameras detected — device {cameras[0].index} is in use.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col items-center gap-2 pt-5">
              <JointAngleGauge
                angle={frame?.primary_angle ?? Number.NaN}
                target={frame?.target_angle ?? 90}
                label={phase.replace("_", " ")}
                size={200}
              />
            </CardContent>
          </Card>

          <div className="grid grid-cols-2 gap-3">
            <Card className="p-4">
              <span className="text-xs text-slate-400">Repetitions</span>
              <p className="mt-1 text-3xl font-bold text-brand-400">
                {capture?.session_active ? capture.rep_count : (frame?.rep_count ?? 0)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {capture?.session_active
                  ? `${capture.attempts} start(s) · ${capture.rejected_reps} rejected`
                  : "not recording"}
              </p>
            </Card>
            <Card className="p-4">
              <span className="text-xs text-slate-400">Pose accuracy</span>
              <p className="mt-1 text-3xl font-bold text-slate-100">
                {frame
                  ? formatPercent(frame.instantaneous_form_score, 0)
                  : capture && capture.last_form_score > 0
                    ? formatPercent(capture.last_form_score, 0)
                    : "—"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {capture && capture.last_rep_duration_sec > 0
                  ? `last rep ${capture.last_rep_duration_sec.toFixed(1)}s`
                  : capture?.session_active && capture.active_hold_sec > 0
                    ? `since start ${capture.active_hold_sec.toFixed(1)}s`
                    : "—"}
              </p>
            </Card>
          </div>

          <Card className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">Phase</span>
              <Badge
                variant={(PHASE_TONE[phase] ?? "neutral") as "neutral" | "brand" | "warning" | "success"}
              >
                {phase.replace("_", " ")}
              </Badge>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs text-slate-400">Since start position</span>
              <span className={cn("text-sm font-medium", "text-slate-200")}>
                {(frame?.hold_duration_sec ?? 0).toFixed(1)}s
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-slate-400">Deviation</span>
              <span className="text-sm font-medium text-slate-200">
                {(frame?.angle_deviation ?? 0).toFixed(1)}°
              </span>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
