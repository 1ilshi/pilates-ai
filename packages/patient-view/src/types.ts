import type { DownsampledPoint } from "@pilates/types";

/** The editable profile fields. */
export interface ProfileDraft {
  name: string;
  gender: string;
  age: string;
  weight: string;
  height: string;
  /** Contact details inherited from the legacy data, now editable. */
  address: string;
  telNumber: string;
}

/** Patient identity, normalised across the desktop record and the portal document. */
export interface PatientProfile {
  id: string;
  name: string;
  age: string;
  gender: string;
  weight: string;
  height: string;
  address?: string | null;
  telNumber?: string | null;
  /** When the record was first created, if known. */
  createdAt?: string | null;
  lastActive: string | null;
}

export interface LegacyPoseSummary {
  count: number;
  avg: number;
  min: number;
  max: number;
  seconds: number;
  last_sample_at: string | null;
}

/** Frozen statistics from the retired FlutterFlow application. */
export interface LegacySummary {
  source: string;
  frozen_at: string;
  last_sample_at: string | null;
  total_samples: number;
  comments_count: number;
  poses: Record<string, LegacyPoseSummary>;
}

export interface SessionSummaryLike {
  total_reps?: number;
  completion_rate?: number;
  mean_form_score?: number;
  peak_rom_angle?: number;
  total_hold_time_sec?: number;
}

export interface RepLike {
  rep_index: number;
  duration_sec: number;
  /** Time held in the target position; absent on records written before it. */
  avg_hold_duration_sec?: number;
  peak_rom_angle: number;
  form_score: number;
  stability_variance?: number;
}

export interface SessionLike {
  session_id: string;
  pose_id: string;
  /** ISO completion timestamp. */
  completed_at: string;
  duration_seconds?: number;
  summary?: SessionSummaryLike;
  reps?: RepLike[];
  upload_state?: string;
}

/** One dated clinical comment. */
export interface PatientComment {
  id: string;
  text: string;
  /** RFC 3339; empty when the record predates the field. */
  created_at: string;
}

export interface TelemetryInfo {
  storage_path?: string;
  gcs_bucket?: string;
  sha256?: string;
  file_size_bytes?: number;
  frame_count?: number;
}

/** A session with the fields the full analysis page needs. */
export interface SessionDetailLike extends SessionLike {
  model_version?: string;
  started_at?: string;
  kinematic_curve?: DownsampledPoint[];
  research_telemetry?: TelemetryInfo | null;
}

export interface PatientViewProps {
  patient: PatientProfile;
  /** Every session recorded for this patient, in any order. */
  sessions: SessionLike[];
  /** Dated comments, newest first. */
  comments?: PatientComment[];
  /** Desktop only: append a comment. */
  onAddComment?: (text: string) => Promise<void>;
  /** Desktop only: remove a comment. */
  onDeleteComment?: (id: string) => Promise<void>;
  legacy?: LegacySummary | null;
  /** Portal passes `false`: the profile renders read-only with no edit control. */
  editable: boolean;
  onBack?: () => void;
  backLabel?: string;
  onStartSession?: () => void;
  onSaveProfile?: (draft: ProfileDraft) => Promise<void>;
  onOpenSession?: (session: SessionLike) => void;
}
