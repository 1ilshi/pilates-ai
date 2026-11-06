import { useEffect, useRef } from "react";
import { SkeletalCanvas, type DetectionBox } from "@pilates/viz";
import type { Keypoint2D, PoseId } from "@pilates/types";
import {
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  previewFrame,
} from "../lib/ipc";

export interface LivePreviewProps {
  keypoints: Keypoint2D[];
  detections?: DetectionBox[];
  poseId?: PoseId;
  running: boolean;
  showAngles?: boolean;
  className?: string;
}

/**
 * Camera preview with the skeletal overlay on top.
 *
 * Frames arrive as raw RGB over Tauri's binary IPC channel and are painted into
 * a canvas at ~15 FPS. The overlay is a separate canvas so the skeleton can
 * update at the full 30 Hz telemetry rate without waiting on frame transfer.
 */
export function LivePreview({
  keypoints,
  detections,
  poseId,
  running,
  showAngles = true,
  className,
}: LivePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);

  useEffect(() => {
    if (!running) {
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const paint = async () => {
      try {
        const buffer = await previewFrame();
        if (cancelled) return;

        const bytes = new Uint8Array(buffer);
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");

        if (context && bytes.length === PREVIEW_WIDTH * PREVIEW_HEIGHT * 3) {
          if (!imageDataRef.current) {
            imageDataRef.current = context.createImageData(
              PREVIEW_WIDTH,
              PREVIEW_HEIGHT,
            );
          }
          const image = imageDataRef.current;
          for (let source = 0, target = 0; source < bytes.length; source += 3, target += 4) {
            image.data[target] = bytes[source];
            image.data[target + 1] = bytes[source + 1];
            image.data[target + 2] = bytes[source + 2];
            image.data[target + 3] = 255;
          }
          context.putImageData(image, 0, 0);
        }
      } catch {
        // Transient IPC failure (e.g. preview stopping): skip this frame.
      }

      if (!cancelled) {
        timer = window.setTimeout(paint, 66);
      }
    };

    void paint();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [running]);

  return (
    <div
      className={className}
      style={{ position: "relative", aspectRatio: `${PREVIEW_WIDTH} / ${PREVIEW_HEIGHT}` }}
    >
      <canvas
        ref={canvasRef}
        width={PREVIEW_WIDTH}
        height={PREVIEW_HEIGHT}
        className="h-full w-full rounded-lg bg-slate-950"
        aria-label="Live camera preview"
      />

      {/* Skeleton overlay, stretched to exactly cover the video canvas. */}
      <div className="pointer-events-none absolute inset-0 [&>canvas]:!h-full [&>canvas]:!w-full">
        <SkeletalCanvas
          keypoints={keypoints}
          detections={detections}
          poseId={poseId}
          width={PREVIEW_WIDTH}
          height={PREVIEW_HEIGHT}
          showAngles={showAngles}
        />
      </div>

      {!running && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg border border-slate-800 bg-slate-950/80 text-sm text-slate-500">
          Camera preview stopped
        </div>
      )}
    </div>
  );
}
