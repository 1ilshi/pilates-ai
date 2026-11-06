import * as React from "react";
import type {
  Keypoint2D,
  PoseDefinitionDocument,
  PoseId,
} from "@pilates/types";
import { POSE_DEFINITIONS } from "@pilates/types";
import {
  CONFIDENCE_COLORS,
  confidenceBand,
  indexKeypoints,
  resolvePoseDefinition,
  toPixelPoint,
} from "./lib/geometry";

/** Rounded-rectangle path without relying on `ctx.roundRect` (WebView2 variance). */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export interface DetectionBox {
  /** Normalized `[x1, y1, x2, y2]`. */
  bbox: [number, number, number, number];
  classId: number;
  confidence: number;
  label?: string;
}

export interface SkeletalCanvasProps {
  /** Normalized (0-1) keypoints for the current frame. */
  keypoints: Keypoint2D[];
  /** Detection boxes to outline, mirroring the YOLO output. */
  detections?: DetectionBox[];
  /** Selects bone connectivity and the angle triplet from pose definitions. */
  poseId?: PoseId;
  /** Overrides the bundled definitions (e.g. a versioned config document). */
  definitions?: PoseDefinitionDocument;
  width?: number;
  height?: number;
  className?: string;
  /** Draw the primary joint arc and its live numeric readout. */
  showAngles?: boolean;
  /** Flip horizontally for mirror-image camera previews. */
  mirrored?: boolean;
  /** Keypoints and bones below this confidence are not drawn. */
  minConfidence?: number;
  /** Draw keypoint label text next to each node. */
  showLabels?: boolean;
  /** Optional background grid to help clinicians judge alignment. */
  showGrid?: boolean;
}

const KEYPOINT_RADIUS = 5;
const ARC_RADIUS = 30;

/** Normalize an angle delta into (-PI, PI]. */
function normalizeAngleDelta(delta: number): number {
  let d = delta;
  while (d <= -Math.PI) d += Math.PI * 2;
  while (d > Math.PI) d -= Math.PI * 2;
  return d;
}

/**
 * High-performance 2D canvas renderer for real-time and replay skeletons.
 *
 * Draws bone segments from the pose definition, colour-codes keypoints by
 * detection confidence (green >= 0.8, yellow 0.5-0.8, red < 0.5) and can
 * overlay the primary joint angle arc with a live degree readout.
 */
export function SkeletalCanvas({
  keypoints,
  detections,
  poseId,
  definitions,
  width = 640,
  height = 480,
  className,
  showAngles = false,
  mirrored = false,
  minConfidence = 0.25,
  showLabels = false,
  showGrid = false,
}: SkeletalCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  const definition = React.useMemo(
    () => resolvePoseDefinition(poseId, definitions ?? POSE_DEFINITIONS),
    [poseId, definitions],
  );
  const bands = (definitions ?? POSE_DEFINITIONS).confidence_bands;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr =
      typeof window !== "undefined" && window.devicePixelRatio
        ? window.devicePixelRatio
        : 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (showGrid) {
      ctx.strokeStyle = "rgba(148, 163, 184, 0.12)";
      ctx.lineWidth = 1;
      const step = 40;
      ctx.beginPath();
      for (let x = 0; x <= width; x += step) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, height);
      }
      for (let y = 0; y <= height; y += step) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(width, y + 0.5);
      }
      ctx.stroke();
    }

    const byId = indexKeypoints(keypoints);
    const visible = (kp: Keypoint2D | undefined): kp is Keypoint2D =>
      !!kp && kp.confidence >= minConfidence;

    // --- Detection boxes --------------------------------------------------
    // Drawn first so bones and keypoints sit on top of the outline.
    if (detections && detections.length) {
      for (const detection of detections) {
        const [x1, y1, x2, y2] = detection.bbox;
        const left = (mirrored ? 1 - x2 : x1) * width;
        const right = (mirrored ? 1 - x1 : x2) * width;
        const top = y1 * height;
        const bottom = y2 * height;

        const colour = CONFIDENCE_COLORS[confidenceBand(detection.confidence, bands)];

        ctx.save();
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 5]);
        ctx.strokeRect(
          left,
          top,
          Math.max(1, right - left),
          Math.max(1, bottom - top),
        );
        ctx.setLineDash([]);

        const label = `${detection.label || `class ${detection.classId}`} ${(
          detection.confidence * 100
        ).toFixed(0)}%`;
        ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
        const textWidth = ctx.measureText(label).width;
        const labelY = Math.max(16, top - 6);

        ctx.fillStyle = colour;
        roundedRectPath(ctx, left, labelY - 14, textWidth + 10, 18, 4);
        ctx.fill();
        ctx.fillStyle = "#0f172a";
        ctx.fillText(label, left + 5, labelY);
        ctx.restore();
      }
    }

    // --- Bone segments ---------------------------------------------------
    if (definition) {
      ctx.lineCap = "round";
      for (const [fromId, toId] of definition.bones) {
        const from = byId.get(fromId);
        const to = byId.get(toId);
        if (!visible(from) || !visible(to)) continue;

        const p1 = toPixelPoint(from, width, height, mirrored);
        const p2 = toPixelPoint(to, width, height, mirrored);

        // Bone opacity tracks the weaker endpoint's confidence.
        const strength = Math.min(from.confidence, to.confidence);
        ctx.globalAlpha = 0.35 + 0.55 * Math.min(1, strength);
        ctx.strokeStyle = "#5eead4";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // --- Keypoints --------------------------------------------------------
    for (const kp of keypoints) {
      if (!visible(kp)) continue;
      const p = toPixelPoint(kp, width, height, mirrored);
      const band = confidenceBand(kp.confidence, bands);

      ctx.beginPath();
      ctx.arc(p.x, p.y, KEYPOINT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = CONFIDENCE_COLORS[band];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#0f172a";
      ctx.stroke();

      if (showLabels) {
        const label = kp.label ?? definition?.keypoint_labels[kp.id];
        if (label) {
          ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
          ctx.fillStyle = "rgba(226, 232, 240, 0.85)";
          ctx.fillText(label, p.x + KEYPOINT_RADIUS + 4, p.y - 4);
        }
      }
    }

    // --- Primary joint angle arc + readout --------------------------------
    if (showAngles && definition) {
      const { a, b, c, name } = definition.primary_angle;
      const kpA = byId.get(a);
      const kpB = byId.get(b);
      const kpC = byId.get(c);

      if (visible(kpA) && visible(kpB) && visible(kpC)) {
        const pa = toPixelPoint(kpA, width, height, mirrored);
        const pb = toPixelPoint(kpB, width, height, mirrored);
        const pc = toPixelPoint(kpC, width, height, mirrored);

        const angA = Math.atan2(pa.y - pb.y, pa.x - pb.x);
        const angC = Math.atan2(pc.y - pb.y, pc.x - pb.x);
        const delta = normalizeAngleDelta(angC - angA);
        const anticlockwise = delta < 0;

        ctx.beginPath();
        ctx.arc(pb.x, pb.y, ARC_RADIUS, angA, angA + delta, anticlockwise);
        ctx.strokeStyle = "rgba(45, 212, 191, 0.9)";
        ctx.lineWidth = 2.5;
        ctx.stroke();

        const degrees = Math.abs((delta * 180) / Math.PI);
        const midAngle = angA + delta / 2;
        const labelX = pb.x + Math.cos(midAngle) * (ARC_RADIUS + 22);
        const labelY = pb.y + Math.sin(midAngle) * (ARC_RADIUS + 22);

        const text = `${degrees.toFixed(1)}\u00b0`;
        ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
        const textWidth = ctx.measureText(text).width;

        ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
        roundedRectPath(ctx, labelX - textWidth / 2 - 6, labelY - 11, textWidth + 12, 22, 6);
        ctx.fill();

        ctx.fillStyle = "#99f6e4";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, labelX, labelY);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";

        // Joint name, when there is room for it.
        ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
        ctx.fillStyle = "rgba(148, 163, 184, 0.9)";
        ctx.fillText(name, labelX - textWidth / 2 - 6, labelY + 22);
      }
    }
  }, [
    keypoints,
    detections,
    definition,
    bands,
    width,
    height,
    mirrored,
    minConfidence,
    showAngles,
    showLabels,
    showGrid,
  ]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={
        definition
          ? `Skeletal overlay for ${definition.display_name}`
          : "Skeletal overlay"
      }
      style={{ width, height }}
      className={className}
    />
  );
}
