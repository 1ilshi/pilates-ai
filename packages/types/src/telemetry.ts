import { MovementPhase } from "./biomechanics";

export interface KinematicFrameRecord {
  timestamp_ms: number;
  frame_index: number;
  phase: MovementPhase;
  primary_angle: number;
  secondary_angle: number;
  form_score: number;
  keypoint_ids: number[];
  keypoint_x: number[];
  keypoint_y: number[];
  keypoint_conf: number[];
  model_class: number;
}
