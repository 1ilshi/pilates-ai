/**
 * `(string & {})` keeps editor autocomplete for the known values while still
 * accepting any custom entry the clinic may need.
 */
export type Gender = "Male" | "Female" | "Other" | (string & {});

export interface PatientInput {
  name: string;
  age: string;
  weight: string;
  height: string;
  gender: Gender;
}

/**
 * Canonical patient entity as stored locally (SQLite outbox) and remotely
 * (Firestore `patients/{patientId}`).
 */
export interface Patient extends PatientInput {
  /** Canonical UUID4. */
  id: string;
  /** Optimistic-concurrency revision, starts at 1. */
  revision: number;
  /** ISO-8601 UTC */
  created_at: string;
  /** ISO-8601 UTC */
  updated_at: string;
  /** O(1) aggregate maintained by the Cloud Function (Step 7). */
  total_sessions?: number;
  /** Lifetime mean form score, 0-100. */
  lifetime_avg_score?: number;
  /** ISO-8601 UTC of the most recent completed session. */
  last_active?: string;
}

/** Backwards-compatible alias retained for existing imports. */
export type PatientRecord = Patient;
