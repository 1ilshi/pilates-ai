import { MovementPhase, PoseId } from "./biomechanics";

export interface RepetitionRecord {
  rep_index: number;
  started_at_ms: number;
  completed_at_ms: number;
  duration_sec: number;
  peak_rom_angle: number;
  avg_hold_duration_sec: number;
  form_score: number; // 0 - 100%
  stability_variance: number;
}

export interface DownsampledPoint {
  t_sec: number;
  angle: number;
  score: number;
  phase: MovementPhase;
}

export interface ClinicalSessionSummary {
  total_reps: number;
  completion_rate: number;
  mean_form_score: number;
  peak_rom_angle: number;
  total_hold_time_sec: number;
}

export interface ResearchTelemetryMeta {
  storage_path: string; // gs:// bucket path
  gcs_bucket: string;
  sha256: string;
  file_size_bytes: number;
  frame_count: number;
}

export interface ClinicalSessionDocument {
  session_id: string;
  patient_id: string;
  pose_id: PoseId;
  model_version: string;
  started_at: string; // ISO UTC
  completed_at: string; // ISO UTC
  duration_seconds: number;
  summary: ClinicalSessionSummary;
  /**
   * Repetitions attempted (a confirmed `start`), whatever the outcome.
   * `summary.completion_rate` is derived from it, so the denominator is kept
   * for auditing. Absent on records written before it was added.
   */
  attempts?: number;
  /** Transitions discarded for being too fast to be a real repetition. */
  rejected_reps?: number;
  /**
   * Frames the camera delivered that never reached the session, because the
   * capture loop ticks slower than the camera. Absent on older records.
   */
  dropped_frames?: number;
  reps: RepetitionRecord[];
  kinematic_curve: DownsampledPoint[];
  /** Version of this document shape; absent on records written before it. */
  schema_version?: number;
  research_telemetry?: ResearchTelemetryMeta;
}
