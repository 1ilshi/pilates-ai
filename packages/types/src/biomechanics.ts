export type PoseId = "pose1" | "pose2" | "pose3" | "pose4" | "pose5";

export const POSE_IDS: readonly PoseId[] = [
  "pose1",
  "pose2",
  "pose3",
  "pose4",
  "pose5",
];

export function isPoseId(value: unknown): value is PoseId {
  return typeof value === "string" && (POSE_IDS as readonly string[]).includes(value);
}

/**
 * Movement phases emitted by the repetition finite state machine.
 *
 * `eccentric` is the lengthening (return to start) half of a repetition and
 * `concentric` the shortening (working) half. Both replace the earlier
 * catch-all `in_motion` so telemetry can distinguish the two directions.
 */
export type MovementPhase =
  | "idle"
  | "start_position"
  | "eccentric"
  | "holding"
  | "concentric"
  | "rep_completed";

export const MOVEMENT_PHASES: readonly MovementPhase[] = [
  "idle",
  "start_position",
  "eccentric",
  "holding",
  "concentric",
  "rep_completed",
];

export function isMovementPhase(value: unknown): value is MovementPhase {
  return (
    typeof value === "string" &&
    (MOVEMENT_PHASES as readonly string[]).includes(value)
  );
}

export interface Keypoint2D {
  id: number;
  label?: string;
  /** Normalized to 0.0 - 1.0 so rendering is canvas-resolution independent. */
  x: number;
  /** Normalized to 0.0 - 1.0. */
  y: number;
  /** 0.0 - 1.0 */
  confidence: number;
}

/** Pixel-space point used by the rendering layer after denormalisation. */
export interface Point2D {
  x: number;
  y: number;
}

export interface LiveTelemetryFrame {
  timestamp_ms: number;
  frame_index: number;
  pose_id: PoseId;
  phase: MovementPhase;
  rep_count: number;
  /** Primary joint angle in degrees (0 - 180). */
  primary_angle: number;
  /** Clinically targeted angle for the current pose, in degrees. */
  target_angle: number;
  /** `abs(primary_angle - target_angle)`. */
  angle_deviation: number;
  /** 0 - 100% */
  instantaneous_form_score: number;
  /** Cumulative seconds inside the target threshold band. */
  hold_duration_sec: number;
  keypoints: Keypoint2D[];
}

/**
 * Composite pose accuracy breakdown. The engine weights these components to
 * produce `instantaneous_form_score`.
 */
export interface FormScoreBreakdown {
  /** How closely the primary angle matched the clinical target (0-100). */
  angle_accuracy: number;
  /** Hold steadiness; high variance lowers this (0-100). */
  stability: number;
  /** Tempo conformance against the pose's intended cadence (0-100). */
  speed: number;
  /** Mean keypoint detection confidence for the frame (0-100). */
  detection_confidence: number;
}

export interface JointAngleReading {
  joint: string;
  angle: number;
  target: number;
  deviation: number;
  /** True when the angle sits inside the pose's target ROM band. */
  in_target_band: boolean;
}
