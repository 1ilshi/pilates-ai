import type { PoseId } from "./biomechanics";
import { POSE_DEFINITIONS } from "./pose-definitions.generated";

/** Angular unit used across the biomechanical contract. */
export type AngleUnit = "degrees";

/**
 * A joint angle is defined by three keypoint indices: `a` and `c` are the
 * segment endpoints and `b` is the vertex (the joint itself). The engine
 * computes `angle(a, b, c)` in degrees, matching
 * `biomechanics::calculate_joint_angle` in the Rust core.
 */
export interface JointAngleSpec {
  name: string;
  a: number;
  b: number;
  c: number;
  unit: AngleUnit;
}

/** Clinically acceptable range of motion for a pose, in degrees. */
export interface TargetRom {
  min: number;
  max: number;
  target: number;
}

/** Confidence bands used to colour-code keypoints in the visualisation layer. */
export interface ConfidenceBands {
  /** At or above this value a keypoint is rendered as "high confidence". */
  high: number;
  /** At or above this value (and below `high`) a keypoint is "medium". */
  medium: number;
}

/**
 * Repetition-counting rules for a pose.
 *
 * In every pose model the class named `end` is the exercise itself — the
 * position being held — and `start` is the neutral position between
 * repetitions. A repetition is one hold of the action pose.
 */
export interface DetectionSpec {
  /** Class for the neutral position between repetitions. */
  start_class: string;
  /** Class for the exercise itself — the position being held. */
  end_class: string;
  min_confidence: number;
  /** Consecutive frames required before a class is believed. */
  confirm_frames: number;
  /** A hold shorter than this is treated as a misdetection. */
  min_hold_sec: number;
  /** Safety cap so a stuck detection cannot run forever. */
  max_hold_sec: number;
  /** How long the pose may go undetected before the hold ends. */
  grace_sec: number;
}

export interface PoseDefinition {
  pose_id: PoseId;
  display_name: string;
  keypoint_count: number;
  /** Index-aligned label per keypoint, e.g. `["hip", "knee", "ankle"]`. */
  keypoint_labels: string[];
  /** Bone segments as `[fromKeypointIndex, toKeypointIndex]` pairs. */
  bones: number[][];
  primary_angle: JointAngleSpec;
  secondary_angle: JointAngleSpec | null;
  target_rom: TargetRom;
  /** Minimum continuous hold time, in seconds, required to count a rep. */
  hold_seconds: number;
  detection: DetectionSpec;
}

/**
 * The full contents of `config/pose-definitions.json`.
 *
 * The JSON file is the single source of truth; `POSE_DEFINITIONS` in
 * `pose-definitions.generated.ts` is generated from it by
 * `tools/generate-pose-definitions.mjs`.
 */
export interface PoseDefinitionDocument {
  schema_version: string;
  description?: string;
  label_source?: string;
  label_note?: string;
  confidence_bands: ConfidenceBands;
  default_hold_seconds: number;
  poses: Record<PoseId, PoseDefinition>;
}

export type PoseDefinitionMap = PoseDefinitionDocument;

/**
 * Human-readable label combining the exercise name with its model number,
 * e.g. `"The Hundred (Pose 1)"`.
 *
 * Clinicians refer to the models by number (`pose1`…`pose5`) while the
 * exercise names are more meaningful in a session record, so both are shown.
 * Unknown ids fall back to the raw value rather than throwing.
 */
export function poseDisplayLabel(poseId: string | null | undefined): string {
  if (!poseId) return "—";
  const definition = POSE_DEFINITIONS.poses[poseId as PoseId];
  const number = poseId.replace(/\D/g, "");
  if (!definition) return number ? `${poseId} (Pose ${number})` : poseId;
  return number ? `${definition.display_name} (Pose ${number})` : definition.display_name;
}
