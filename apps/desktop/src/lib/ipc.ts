/**
 * Typed bridge to the Rust engine.
 *
 * Every call degrades gracefully when the UI is opened in a plain browser
 * (`pnpm dev` without Tauri): `isTauri()` is false and the pages render an
 * explanatory banner instead of throwing.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LiveTelemetryFrame, MovementPhase } from "@pilates/types";

export interface CameraDescriptor {
  index: number;
  human_name: string;
  description: string;
  is_default: boolean;
}

export interface PreviewStatus {
  running: boolean;
  device: CameraDescriptor | null;
  pose_id: string | null;
  provider: string;
  inference_available: boolean;
}

export interface PoseSummary {
  pose_id: string;
  display_name: string;
  keypoint_count: number;
  target_angle: number;
  hold_seconds: number;
  model_version: string | null;
}

export interface EngineStatus {
  inference_available: boolean;
  runtime_found: boolean;
  provider: string;
  detail: string;
  poses: PoseSummary[];
  cloud_sync_enabled: boolean;
  /**
   * A telemetry archive bucket is configured. When false, sessions are still
   * recorded and queued locally, but their Parquet archive is never uploaded,
   * so the portal shows no telemetry for the patient.
   */
  bucket_configured: boolean;
}

export interface PatientRecord {
  id: string;
  name: string;
  age: string;
  weight: string;
  height: string;
  gender: string;
  revision: number;
  /** `tombstone` rows are soft-deleted and hidden from the directory. */
  local_state: "active" | "tombstone";
  /** Contact details that predate this application (Firestore-only). */
  address: string | null;
  note: string | null;
  tel_number: string | null;
  /** Frozen FlutterFlow-era statistics, materialised as JSON. */
  legacy_json: string | null;
  created_at: string;
  updated_at: string;
  total_sessions: number | null;
  lifetime_avg_score: number | null;
  last_active: string | null;
}

export interface LegacyPoseSummary {
  count: number;
  avg: number;
  min: number;
  max: number;
  seconds: number;
  last_sample_at: string | null;
}

/** Frozen statistics from the previous application. Never updated. */
export interface LegacySummary {
  source: string;
  frozen_at: string;
  last_sample_at: string | null;
  total_samples: number;
  comments_count: number;
  poses: Record<string, LegacyPoseSummary>;
}

/**
 * Parse the materialised `legacy_json` field.
 *
 * Returns `null` for patients created in this application, which have no legacy
 * history. Malformed JSON is treated the same way rather than throwing — a
 * display panel must never break the page.
 */
export function parseLegacy(raw: string | null | undefined): LegacySummary | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LegacySummary>;
    if (!parsed || typeof parsed !== "object" || !parsed.poses) return null;
    return {
      source: parsed.source ?? "legacy",
      frozen_at: parsed.frozen_at ?? "",
      last_sample_at: parsed.last_sample_at ?? null,
      total_samples: Number(parsed.total_samples ?? 0),
      comments_count: Number(parsed.comments_count ?? 0),
      poses: parsed.poses as Record<string, LegacyPoseSummary>,
    };
  } catch {
    return null;
  }
}

export interface PatientInput {
  id?: string;
  name: string;
  age?: string;
  weight?: string;
  height?: string;
  gender?: string;
  /** Omit to leave unchanged; send "" to clear. */
  address?: string;
  tel_number?: string;
}

export interface OutboxStats {
  patients: number;
  patients_deleted: number;
  sessions_total: number;
  sessions_pending: number;
  sessions_failed: number;
  /** Parked after exhausting their retry budget; archives still on disk. */
  sessions_dead: number;
  queued_operations: number;
}

export interface SyncReport {
  attempted: number;
  synced: number;
  failed: number;
  errors: string[];
  enabled: boolean;
  patients_synced: number;
  /**
   * Writes refused because another workstation edited the document first.
   * Parked rather than retried: the clinician must re-open the patient.
   */
  conflicts: number;
}

export interface PullReport {
  fetched: number;
  imported: number;
  updated: number;
  /** Rows deleted here that Firestore still lists as active. */
  kept_deleted: number;
  /** Session documents downloaded from other workstations. */
  sessions_imported: number;
  /** Why the session pull failed, if it did. */
  error?: string | null;
  enabled: boolean;
}

export interface SessionListItem {
  session_id: string;
  patient_id: string;
  pose_id: string;
  created_at: string;
  upload_state: string;
  document: unknown;
}

/** Payload pushed on the `telemetry-frame` event. Mirrors `LiveTelemetryFrame`. */
export interface TelemetryFrame {
  timestamp_ms: number;
  frame_index: number;
  pose_id: string;
  phase: MovementPhase;
  rep_count: number;
  primary_angle: number;
  target_angle: number;
  angle_deviation: number;
  instantaneous_form_score: number;
  hold_duration_sec: number;
  keypoints: Array<{
    id: number;
    label: string;
    x: number;
    y: number;
    confidence: number;
  }>;
  detections: Array<{
    bbox: [number, number, number, number];
    class_id: number;
    confidence: number;
    label: string;
  }>;
  /** Strongest class in the frame, even below the display threshold. */
  best_class_label: string;
  best_class_score: number;
  inference_ms: number;
}

export const PREVIEW_WIDTH = 320;
export const PREVIEW_HEIGHT = 240;

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(
      "The native engine is unavailable: run `pnpm tauri dev` to launch the desktop app.",
    );
  }
  return invoke<T>(command, args);
}

// --- devices & engine ------------------------------------------------------

export interface CaptureStatus {
  preview_running: boolean;
  session_active: boolean;
  session_frames: number;
  engine_available: boolean;
  camera_frames: number;
  /** Repetitions counted so far in the active session. */
  rep_count: number;
  /** `start` positions confirmed — one per attempted repetition. */
  attempts: number;
  /** Transitions discarded for being too fast. */
  rejected_reps: number;
  /** Duration of the most recently counted repetition, in seconds. */
  last_rep_duration_sec: number;
  /** Time since the current `start`, in seconds (0 when idle). */
  active_hold_sec: number;
  /** Latest composite pose accuracy, 0-100. */
  last_form_score: number;
  /**
   * Last fatal error from the capture thread. The preview freezes on the last
   * frame when this is set, so the UI must say so rather than keep showing a
   * live badge over a still image.
   */
  camera_error?: string | null;
}

export const listCameras = () => call<CameraDescriptor[]>("list_cameras");
/** One pairing code, shown to the user while they authorise the machine. */
export interface PairingStart {
  code: string;
  secret: string;
  expires_at: string;
}

export interface PairingStatus {
  paired: boolean;
  instance_id: string;
}

/** Never fails: the gate must render even if the file system misbehaves. */
export const pairingStatus = () => call<PairingStatus>("pairing_status");
export const pairingStart = () => call<PairingStart>("pairing_start");
/** Polls once; `true` means the workstation is now paired. */
export const pairingPoll = (code: string, secret: string) =>
  call<boolean>("pairing_poll", { code, secret });

/**
 * Sign this workstation in with a clinic account.
 *
 * The easy first-run path: the password is used once and never stored, and the
 * credential that persists is the same refresh token pairing produces. Rejects
 * an account without the `clinic` claim, so the user is told they need access
 * instead of opening onto a patient list that never syncs.
 */
export const authSignIn = (email: string, password: string) =>
  call<void>("auth_sign_in", { email, password });

/** Remove this workstation's credential so the next person can sign in. */
export const authSignOut = () => call<void>("auth_sign_out");

/** Opens the clinical portal in the default browser. */
export const openPortal = () => call<void>("open_portal");
/** Open any https URL in the default browser (used by the pairing screen). */
export const openExternal = (url: string) => call<void>("open_external", { url });
export const captureStatus = () => call<CaptureStatus>("capture_status");
export const engineStatus = () => call<EngineStatus>("engine_status");
export const movementPhases = () => call<MovementPhase[]>("movement_phases");

// --- preview ---------------------------------------------------------------

export const startPreview = (deviceIndex?: number, poseId?: string) =>
  call<PreviewStatus>("start_preview", { deviceIndex, poseId });
export const stopPreview = () => call<PreviewStatus>("stop_preview");
export const setPreviewPose = (poseId: string) =>
  call<void>("set_preview_pose", { poseId });

/** Raw RGB bytes for one downscaled preview frame (empty when idle). */
export const previewFrame = () => call<ArrayBuffer>("preview_frame");

export function onTelemetryFrame(
  handler: (frame: TelemetryFrame) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen<TelemetryFrame>("telemetry-frame", (event) => handler(event.payload));
}

export function onEngineError(handler: (message: string) => void): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen<string>("engine-error", (event) => handler(event.payload));
}

// --- sessions --------------------------------------------------------------

export const startSession = (patientId: string, poseId: string) =>
  call<string>("start_session", { patientId, poseId });
export const captureTick = () => call<TelemetryFrame | null>("capture_tick");
export const stopSession = () =>
  call<Record<string, unknown>>("stop_session");
export const listSessions = (patientId: string) =>
  call<SessionListItem[]>("list_sessions", { patientId });
/** Every session across all patients, newest first. */
export const listAllSessions = () => call<SessionListItem[]>("list_all_sessions");

export const getSessionDocument = (sessionId: string) =>
  call<Record<string, unknown>>("get_session_document", { sessionId });

// --- patients & sync -------------------------------------------------------

export const listPatients = () => call<PatientRecord[]>("list_patients");
export const savePatient = (patient: PatientInput) =>
  call<PatientRecord>("save_patient", { patient });
export const deletePatient = (patientId: string) =>
  call<void>("delete_patient", { patientId });
export const outboxStats = () => call<OutboxStats>("outbox_stats");
export const syncNow = () => call<SyncReport>("sync_now");
/** Pull the Firestore patient roster into the local store. */
export const syncPullPatients = () => call<PullReport>("sync_pull_patients");
/** One dated clinical comment. */
export interface PatientComment {
  id: string;
  text: string;
  created_at: string;
}

export const listComments = (patientId: string) =>
  call<PatientComment[]>("list_comments", { patientId });
export const addComment = (patientId: string, text: string) =>
  call<PatientComment>("add_comment", { patientId, text });
export const deleteComment = (patientId: string, commentId: string) =>
  call<void>("delete_comment", { patientId, commentId });

/** True when another workstation changed something since the last check. */
export const syncCheckRemote = () => call<boolean>("sync_check_remote");

/** Shape of `LiveTelemetryFrame` is a superset of `TelemetryFrame`. */
export type { LiveTelemetryFrame };
