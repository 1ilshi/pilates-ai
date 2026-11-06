import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  PatientView,
  type LegacySummary,
  type PatientProfile,
  type SessionLike,
} from "@pilates/patient-view";
import { Card } from "@pilates/ui";
import {
  listenComments,
  listenPatient,
  listenSessions,
  type PortalComment,
  type PortalPatient,
  type PortalSession,
} from "../lib/data";

function toProfile(patient: PortalPatient): PatientProfile {
  return {
    id: patient.id,
    name: patient.name,
    age: patient.age,
    gender: patient.gender,
    weight: patient.weight,
    height: patient.height,
    address: patient.address,
    telNumber: patient.tel_number,
    lastActive: patient.lastActive,
  };
}

function toSessionLike(session: PortalSession): SessionLike {
  return {
    session_id: session.session_id ?? session.id,
    pose_id: session.pose_id,
    completed_at: session.completed_at,
    duration_seconds: session.duration_seconds,
    summary: session.summary,
    reps: session.reps,
  };
}

/**
 * Portal patient record.
 *
 * Renders the same `PatientView` as the desktop app, with `editable` off: the
 * portal is read-only, so no edit affordance is shown at all rather than a
 * disabled control that invites the question "why can't I?".
 */
export function PatientPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Where this page was opened from, so "back" returns there rather than
  // always dropping to the patient list.
  const origin = (location.state as { from?: string } | null)?.from;
  const backLabel = origin ?? "Patients";
  const [patient, setPatient] = useState<PortalPatient | null>(null);
  const [sessions, setSessions] = useState<PortalSession[]>([]);
  const [comments, setComments] = useState<PortalComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const stopPatient = listenPatient(
      id,
      (record) => {
        if (cancelled) return;
        setPatient(record);
        setLoading(false);
      },
      (caught) => {
        if (cancelled) return;
        setError(String(caught));
        setLoading(false);
      },
    );

    // Sessions and comments stream in independently, so a slow one cannot hold
    // up the profile.
    const stopSessions = listenSessions(id, (rows) => {
      if (!cancelled) setSessions(rows);
    });

    const stopComments = listenComments(id, (rows) => {
      if (!cancelled) setComments(rows);
    });

    return () => {
      cancelled = true;
      stopPatient();
      stopSessions();
      stopComments();
    };
  }, [id]);

  if (loading) {
    return <p className="text-sm text-slate-400">Loading patient…</p>;
  }

  if (!patient) {
    return (
      <Card className="p-6 text-sm text-slate-400">
        {error ?? "Patient not found."}
      </Card>
    );
  }

  return (
    <PatientView
      patient={toProfile(patient)}
      sessions={sessions.map(toSessionLike)}
      comments={comments}
      legacy={patient.legacy as LegacySummary | null}
      editable={false}
      onBack={() =>
        origin ? navigate(-1) : navigate("/patients")
      }
      backLabel={backLabel}
      onOpenSession={(session) =>
        navigate(`/patients/${patient.id}/sessions/${session.session_id}`, {
          state: { from: patient.name },
        })
      }
    />
  );
}
