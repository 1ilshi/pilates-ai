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
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
  formatPercent,
} from "@pilates/ui";
import { LivePreview } from "../components/LivePreview";
import { useTauriCapture } from "../hooks/useTauriCapture";
import { signalSync } from "../lib/syncSignal";
import { getSelectedCamera } from "../lib/cameraPreference";
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
  idle: "secondary",
  start_position: "secondary",
  eccentric: "default",
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
      await start(getSelectedCamera() ?? undefined, poseId);
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
    /* Camera fills the workspace. Panels float above it, small and translucent
       so the view is never shielded — the session still has every control. */
    <div className="relative h-full min-h-0 w-full overflow-hidden rounded-card border border-border bg-black">
      <LivePreview
        running={running}
        keypoints={keypoints}
        detections={detections}
        poseId={poseId as PoseId}
        showAngles
        className="absolute inset-0 h-full w-full"
      />

      {/* Warnings stay readable but take only as much room as they need. */}
      <div className="pointer-events-none absolute left-1/2 top-3 z-20 flex w-full max-w-xl -translate-x-1/2 flex-col gap-2 px-3">
        {!native && (
          <Card className="pointer-events-auto border-amber-500/30 bg-background/85 p-2.5 text-xs text-amber-300 backdrop-blur-sm">
            Browser preview mode — the Rust capture engine is only available inside
            Tauri.
          </Card>
        )}

        {(engineError || sessionError) && (
          <Card className="pointer-events-auto border-red-500/30 bg-background/85 p-2.5 text-xs text-red-300 backdrop-blur-sm">
            {sessionError ?? engineError}
          </Card>
        )}

        {capture?.camera_error && (
          <Card className="pointer-events-auto border-rose-500/30 bg-background/85 p-2.5 text-xs text-rose-200 backdrop-blur-sm">
            The camera stopped delivering frames — {capture.camera_error}. The preview
            is showing its last image, so anything recorded now is not from the camera.
            Check the connection, then stop and start the preview.
          </Card>
        )}

        {capture?.preview_running && !capture.engine_available && (
          <Card className="pointer-events-auto border-amber-500/30 bg-background/85 p-2.5 text-xs text-amber-300 backdrop-blur-sm">
            Pose detection has not loaded — {engine?.detail ?? "unknown error"}. Recording
            still works, but no skeleton or repetitions will be detected.
          </Card>
        )}

        {engine && !engine.bucket_configured && (
          <Card className="pointer-events-auto border-amber-500/30 bg-background/85 p-2.5 text-xs text-amber-300 backdrop-blur-sm">
            Archive upload is disabled — no telemetry bucket is configured. Sessions are
            recorded and queued on this computer, but the portal will show no charts for
            them until{" "}
            <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[11px]">
              bucket
            </code>{" "}
            is set in{" "}
            <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[11px]">
              cloud.json
            </code>{" "}
            (or{" "}
            <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[11px]">
              PILATES_FIREBASE_BUCKET
            </code>{" "}
            is set for this installation).
          </Card>
        )}
      </div>

      <div className="pointer-events-none absolute left-3 top-3 rounded bg-black/80 px-2 py-1 font-mono text-[10px] leading-tight text-foreground/80">
        det {frame?.detections?.length ?? 0} · kp {keypoints.length} · ev{" "}
        {telemetryFrames}
      </div>

      {/* Engine / capture telemetry, tucked into one small strip. */}
      <div className="absolute left-3 top-14 z-10 flex max-w-[55%] flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border/50 bg-background/70 px-3 py-2 text-[11px] text-muted-foreground backdrop-blur-sm">
        <Badge variant={running ? "success" : "secondary"} dot>
          {running ? "Live" : "Idle"}
        </Badge>
        {status?.device && (
          <span className="inline-flex items-center gap-1">
            <Camera className="h-3.5 w-3.5" aria-hidden="true" />
            {status.device.human_name}
          </span>
        )}
        <span>
          Engine: {capture ? (capture.engine_available ? "ready" : "not loaded") : "…"}
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
                  : "text-muted-foreground"
            }
          >
            Model: {frame.best_class_label || "—"} {frame.best_class_score.toFixed(2)}
          </span>
        )}
        {frame && <span>{frame.inference_ms.toFixed(0)} ms</span>}
        <span className={telemetryFrames === 0 ? "text-amber-400" : "text-muted-foreground"}>
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

      {/* Reps + accuracy: small, semi-transparent, out of the way. */}
      <div className="absolute right-3 top-3 z-10 flex gap-2">
        <div className="rounded-xl border border-border/50 bg-background/75 px-3 py-2 backdrop-blur-sm">
          <span className="block text-[10px] text-muted-foreground">Repetitions</span>
          <p className="font-mono text-xl font-semibold text-primary">
            {capture?.session_active ? capture.rep_count : (frame?.rep_count ?? 0)}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {capture?.session_active
              ? `${capture.attempts} start(s) · ${capture.rejected_reps} rejected`
              : "not recording"}
          </p>
        </div>
        <div className="rounded-xl border border-border/50 bg-background/75 px-3 py-2 backdrop-blur-sm">
          <span className="block text-[10px] text-muted-foreground">Pose accuracy</span>
          <p className="font-mono text-xl font-semibold text-foreground">
            {frame
              ? formatPercent(frame.instantaneous_form_score, 0)
              : capture && capture.last_form_score > 0
                ? formatPercent(capture.last_form_score, 0)
                : "—"}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {capture && capture.last_rep_duration_sec > 0
              ? `last rep ${capture.last_rep_duration_sec.toFixed(1)}s`
              : capture?.session_active && capture.active_hold_sec > 0
                ? `since start ${capture.active_hold_sec.toFixed(1)}s`
                : "—"}
          </p>
        </div>
      </div>

      <div className="absolute right-3 top-28 z-10 w-32 rounded-xl border border-border/50 bg-background/60 p-1 backdrop-blur-sm">
        <JointAngleGauge
          angle={frame?.primary_angle ?? Number.NaN}
          target={frame?.target_angle ?? 90}
          label={phase.replace("_", " ")}
          size={112}
        />
      </div>

      {/* Phase: compact, bottom-right. */}
      <div className="absolute bottom-3 right-3 z-10 w-48 rounded-xl border border-border/50 bg-background/75 p-3 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">Phase</span>
          <Badge
            variant={(PHASE_TONE[phase] ?? "secondary") as "secondary" | "default" | "warning" | "success"}
          >
            {phase.replace("_", " ")}
          </Badge>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">Since start position</span>
          <span className={cn("text-xs font-medium", "text-foreground")}>
            {(frame?.hold_duration_sec ?? 0).toFixed(1)}s
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">Deviation</span>
          <span className="text-xs font-medium text-foreground">
            {(frame?.angle_deviation ?? 0).toFixed(1)}°
          </span>
        </div>
      </div>

      {/* Session controls stay fully interactive, bottom-left. */}
      <Card className="absolute bottom-3 left-3 z-10 w-72 gap-3 border-border/60 bg-background/80 p-4 backdrop-blur-sm">
        <CardHeader className="pb-0">
          <CardTitle className="text-sm">Session</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-0 pb-0">
          <div className="text-xs text-muted-foreground">
            Patient:{" "}
            <span className="font-medium text-foreground">
              {patient?.name ?? "none selected"}
            </span>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="capture-pose">Pose</Label>
            <Select
              value={poseId}
              onValueChange={(value) => {
                setPoseId(value);
                void selectPose(value);
              }}
            >
              <SelectTrigger id="capture-pose" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(poses.length
                  ? poses
                  : [{ pose_id: "pose1", display_name: "Pose 1" } as PoseSummary]
                ).map((pose) => (
                  <SelectItem key={pose.pose_id} value={pose.pose_id}>
                    {poseDisplayLabel(pose.pose_id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {!sessionId ? (
              <Button
                onClick={() => void beginSession()}
                disabled={!native || busy || !patient}
                className="w-full"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                Start
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={() => void endSession()}
                loading={finishing}
                className="col-span-2 h-12 w-full text-base"
              >
                <Square className="h-4 w-4" aria-hidden="true" />
                Stop &amp; save
              </Button>
            )}

            {!sessionId && (
              <Button
                variant="outline"
                onClick={() => void (running ? stop() : start(getSelectedCamera() ?? undefined, poseId))}
                disabled={!native || busy}
                className="w-full"
              >
                {running ? "Stop preview" : "Preview"}
              </Button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setMuted((value) => !value)}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {muted ? (
              <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {muted ? "Chime muted" : "Chime on rep completion"}
          </button>

          {cameras.length > 1 && (
            <p className="text-xs text-muted-foreground">
              {cameras.length} cameras detected — using{" "}
              {status?.device?.human_name ??
                cameras.find((camera) => camera.index === (getSelectedCamera() ?? 0))?.human_name ??
                `device ${getSelectedCamera() ?? 0}`}
              .
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
