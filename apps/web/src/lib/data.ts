import {
  collection,
  collectionGroup,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  type Unsubscribe,
} from "firebase/firestore";
import type { ClinicalSessionDocument } from "@pilates/types";
import { db } from "./firebase";
import { parseLegacy, type LegacySummary } from "./legacy";

export interface PortalPatient {
  id: string;
  name: string;
  age: string;
  weight: string;
  height: string;
  gender: string;
  address: string | null;
  note: string | null;
  tel_number: string | null;
  totalSessions: number;
  lifetimeAvgScore: number | null;
  lastActive: string | null;
  /** `tombstone` marks a patient deleted on a workstation. */
  localState: string;
  legacy: LegacySummary | null;
}

export type PortalSession = ClinicalSessionDocument & { id: string };

type RawFields = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function toPatient(id: string, data: RawFields): PortalPatient {
  const total = data.total_sessions;
  const score = data.lifetime_avg_score;
  return {
    id,
    name: text(data.name),
    age: text(data.age),
    weight: text(data.weight),
    height: text(data.height),
    gender: text(data.gender),
    address: optionalText(data.address),
    note: optionalText(data.note),
    tel_number: optionalText(data.tel_number),
    totalSessions: typeof total === "number" ? total : 0,
    lifetimeAvgScore: typeof score === "number" ? score : null,
    lastActive: optionalText(data.last_active),
    localState: text(data.local_state) || "active",
    legacy: parseLegacy(data.legacy_json),
  };
}

/**
 * Deletions are soft: a workstation hides the row and PATCHes
 * `local_state = "tombstone"` instead of destroying the document (sessions in
 * the subcollection must survive). The portal has to honour that flag, or every
 * patient ever deleted keeps showing up here next to its replacement.
 */
export function isVisible(patient: PortalPatient): boolean {
  return Boolean(patient.name) && patient.localState !== "tombstone";
}

function toSession(id: string, data: RawFields): PortalSession {
  return { ...(data as unknown as ClinicalSessionDocument), id };
}

/** Newest first. Sorting client-side avoids needing a composite index. */
function byRecency(a: PortalSession, b: PortalSession): number {
  return Date.parse(b.completed_at ?? "") - Date.parse(a.completed_at ?? "");
}

/** One dated clinical comment, written by the desktop. */
export interface PortalComment {
  id: string;
  text: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Live subscriptions
//
// The portal is read-only, so every read is a listener: a clinician watching a
// patient sees a session appear without reloading. These replace the previous
// pattern of re-downloading the entire roster and every session on a timer.
// ---------------------------------------------------------------------------

/**
 * How many of the newest sessions the clinic dashboard loads.
 *
 * The dashboard only needs recent activity for its charts and triage list, so a
 * bounded query keeps the read cost flat as the archive grows. A patient's full
 * history is loaded separately by the patient page.
 */
export const CLINIC_SESSION_LIMIT = 500;

/** Newest-first across every patient, in one query instead of one per patient. */
export function clinicSessionsQuery() {
  return query(
    collectionGroup(db, "sessions"),
    orderBy("completed_at", "desc"),
    limit(CLINIC_SESSION_LIMIT),
  );
}

/** Map a collection-group hit; legacy documents may lack `patient_id`. */
function toPortalSession(
  id: string,
  data: RawFields,
  fallbackPatientId: string,
): PortalSession {
  return {
    ...(data as unknown as ClinicalSessionDocument),
    id,
    patient_id: text(data.patient_id) || fallbackPatientId,
  };
}

export function listenPatients(
  onChange: (patients: PortalPatient[]) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    collection(db, "patients"),
    (snapshot) => {
      onChange(
        snapshot.docs
          .map((entry) => toPatient(entry.id, entry.data() as RawFields))
          .filter(isVisible)
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    },
    (error) => onError?.(error),
  );
}

export function listenPatient(
  id: string,
  onChange: (patient: PortalPatient | null) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, "patients", id),
    (snapshot) => {
      if (!snapshot.exists()) {
        onChange(null);
        return;
      }
      const patient = toPatient(snapshot.id, snapshot.data() as RawFields);
      onChange(isVisible(patient) ? patient : null);
    },
    (error) => onError?.(error),
  );
}

export function listenSessions(
  patientId: string,
  onChange: (sessions: PortalSession[]) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    collection(db, "patients", patientId, "sessions"),
    (snapshot) => {
      onChange(
        snapshot.docs
          .map((entry) => toSession(entry.id, entry.data() as RawFields))
          .sort(byRecency),
      );
    },
    (error) => onError?.(error),
  );
}

export function listenSession(
  patientId: string,
  sessionId: string,
  onChange: (session: PortalSession | null) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, "patients", patientId, "sessions", sessionId),
    (snapshot) => {
      onChange(
        snapshot.exists()
          ? toSession(snapshot.id, snapshot.data() as RawFields)
          : null,
      );
    },
    (error) => onError?.(error),
  );
}

export function listenComments(
  patientId: string,
  onChange: (comments: PortalComment[]) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    collection(db, "patients", patientId, "comments"),
    (snapshot) => {
      onChange(
        snapshot.docs
          .map((entry) => {
            const data = entry.data() as RawFields;
            return {
              id: entry.id,
              text: text(data.text),
              created_at: text(data.created_at),
            };
          })
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      );
    },
    (error) => onError?.(error),
  );
}

/** The clinic-wide session feed used by the dashboard and analysis pages. */
export function listenClinicSessions(
  onChange: (sessions: PortalSession[]) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    clinicSessionsQuery(),
    (snapshot) => {
      onChange(
        snapshot.docs
          .map((entry) =>
            toPortalSession(
              entry.id,
              entry.data() as RawFields,
              entry.ref.parent.parent?.id ?? "",
            ),
          )
          .sort(byRecency),
      );
    },
    (error) => onError?.(error),
  );
}
