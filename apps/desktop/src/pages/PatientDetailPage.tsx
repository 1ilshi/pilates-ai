import { useCallback, useEffect, useState } from "react";
import {
  PatientView,
  type LegacySummary,
  type PatientProfile,
  type ProfileDraft,
  type SessionLike,
} from "@pilates/patient-view";
import type { ClinicalSessionDocument } from "@pilates/types";
import {
  addComment,
  deleteComment,
  isTauri,
  listComments,
  listSessions,
  parseLegacy,
  savePatient,
  type PatientRecord,
  type PatientComment,
  type SessionListItem,
} from "../lib/ipc";
import { signalSync } from "../lib/syncSignal";

export interface PatientDetailPageProps {
  patient: PatientRecord;
  onBack: () => void;
  /** Name of the page the back button returns to. */
  backLabel?: string;
  onStartSession: () => void;
  onOpenSession: (document: ClinicalSessionDocument) => void;
  /** Called after the profile is saved so the parent can refresh. */
  onPatientSaved: (patient: PatientRecord) => void;
}

/** Narrow a stored session document into the shape the shared view expects. */
function toSessionLike(item: SessionListItem): SessionLike {
  const document = (item.document ?? {}) as Partial<ClinicalSessionDocument>;
  return {
    session_id: item.session_id,
    pose_id: item.pose_id,
    completed_at: document.completed_at ?? item.created_at,
    duration_seconds: document.duration_seconds,
    summary: document.summary,
    reps: document.reps,
    upload_state: item.upload_state,
  };
}

/**
 * Desktop patient record.
 *
 * The page itself lives in `@pilates/patient-view`, shared with the portal, so
 * the clinical view is identical on both surfaces. This file only supplies the
 * local data and the write callbacks.
 */
export function PatientDetailPage({
  patient,
  onBack,
  backLabel = "Patients",
  onStartSession,
  onOpenSession,
  onPatientSaved,
}: PatientDetailPageProps) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [comments, setComments] = useState<PatientComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSessions = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setSessions(await listSessions(patient.id));
      setError(null);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  }, [patient.id]);

  const loadComments = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setComments(await listComments(patient.id));
    } catch {
      // Comments are cloud-only; offline simply shows none.
    }
  }, [patient.id]);

  useEffect(() => {
    void loadSessions();
    void loadComments();
  }, [loadSessions, loadComments]);

  // Background sync may bring in sessions recorded elsewhere.
  useEffect(() => {
    const onChanged = () => {
      void loadSessions();
      void loadComments();
    };
    window.addEventListener("pilates:data-changed", onChanged);
    return () => window.removeEventListener("pilates:data-changed", onChanged);
  }, [loadSessions, loadComments]);

  const profile: PatientProfile = {
    id: patient.id,
    name: patient.name,
    age: patient.age,
    gender: patient.gender,
    weight: patient.weight,
    height: patient.height,
    address: patient.address,
    telNumber: patient.tel_number,
    createdAt: patient.created_at,
    lastActive: patient.last_active,
  };

  const saveProfile = async (draft: ProfileDraft) => {
    const updated = await savePatient({
      id: patient.id,
      name: draft.name,
      gender: draft.gender,
      age: draft.age,
      weight: draft.weight,
      height: draft.height,
      address: draft.address,
      tel_number: draft.telNumber,
    });
    onPatientSaved(updated);
    signalSync();
  };

  const openSession = (session: SessionLike) => {
    const item = sessions.find((entry) => entry.session_id === session.session_id);
    if (item) onOpenSession(item.document as ClinicalSessionDocument);
  };

  // Without this the page flashes "No sessions recorded yet" before the
  // local query returns.
  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-sm text-slate-500">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-700 border-t-brand-400" />
        Loading {patient.name}…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-control border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">
          {error}
        </p>
      )}
      <PatientView
        patient={profile}
        sessions={sessions.map(toSessionLike)}
        comments={comments}
        legacy={parseLegacy(patient.legacy_json) as LegacySummary | null}
        editable
        onBack={onBack}
        backLabel={backLabel}
        onStartSession={onStartSession}
        onSaveProfile={saveProfile}
        onOpenSession={openSession}
        onAddComment={async (text) => {
          await addComment(patient.id, text);
          await loadComments();
        }}
        onDeleteComment={async (id) => {
          await deleteComment(patient.id, id);
          await loadComments();
        }}
      />
    </div>
  );
}
