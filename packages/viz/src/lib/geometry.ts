import type {
  ConfidenceBands,
  Keypoint2D,
  Point2D,
  PoseDefinition,
} from "@pilates/types";
import { POSE_DEFINITIONS } from "@pilates/types";

export type ConfidenceBand = "high" | "medium" | "low";

/** Canvas colours per confidence band, matching the design tokens in @pilates/ui. */
export const CONFIDENCE_COLORS: Record<ConfidenceBand, string> = {
  high: "#22c55e",
  medium: "#eab308",
  low: "#ef4444",
};

/**
 * Classify a keypoint confidence into the clinical rendering bands:
 * green >= high, yellow >= medium, red below.
 */
export function confidenceBand(
  confidence: number,
  bands: ConfidenceBands = POSE_DEFINITIONS.confidence_bands,
): ConfidenceBand {
  if (!Number.isFinite(confidence)) return "low";
  if (confidence >= bands.high) return "high";
  if (confidence >= bands.medium) return "medium";
  return "low";
}

/** Look up a pose definition, falling back to the bundled defaults. */
export function resolvePoseDefinition(
  poseId: string | undefined,
  definitions = POSE_DEFINITIONS,
): PoseDefinition | undefined {
  if (!poseId) return undefined;
  return definitions.poses[poseId as keyof typeof definitions.poses];
}

/**
 * Angle at vertex `b` formed by segments b->a and b->c, in degrees (0-180).
 *
 * Mirrors `biomechanics::calculate_joint_angle` in the Rust core so the UI and
 * the engine never disagree about a displayed angle.
 */
export function calculateJointAngle(
  a: Point2D,
  b: Point2D,
  c: Point2D,
): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;

  const len1 = Math.hypot(v1x, v1y);
  const len2 = Math.hypot(v2x, v2y);
  if (len1 === 0 || len2 === 0) return Number.NaN;

  const dot = (v1x / len1) * (v2x / len2) + (v1y / len1) * (v2y / len2);
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}

/** Convert normalized keypoints (0-1) into pixel space for a canvas. */
export function toPixelPoint(
  keypoint: Keypoint2D,
  width: number,
  height: number,
  mirrored = false,
): Point2D {
  return {
    x: (mirrored ? 1 - keypoint.x : keypoint.x) * width,
    y: keypoint.y * height,
  };
}

/** Index keypoints by their `id` for O(1) lookup when resolving bone endpoints. */
export function indexKeypoints(keypoints: Keypoint2D[]): Map<number, Keypoint2D> {
  const map = new Map<number, Keypoint2D>();
  for (const keypoint of keypoints) map.set(keypoint.id, keypoint);
  return map;
}

/**
 * Compute the primary joint angle for a pose from a keypoint set.
 * Returns `null` when any of the three required keypoints is missing.
 */
export function computePrimaryAngle(
  keypoints: Keypoint2D[],
  definition: PoseDefinition,
  width = 1,
  height = 1,
): number | null {
  const byId = indexKeypoints(keypoints);
  const { a, b, c } = definition.primary_angle;
  const kpA = byId.get(a);
  const kpB = byId.get(b);
  const kpC = byId.get(c);
  if (!kpA || !kpB || !kpC) return null;

  const angle = calculateJointAngle(
    toPixelPoint(kpA, width, height),
    toPixelPoint(kpB, width, height),
    toPixelPoint(kpC, width, height),
  );
  return Number.isFinite(angle) ? angle : null;
}
