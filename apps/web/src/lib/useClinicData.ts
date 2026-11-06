import { useEffect, useState } from "react";
import {
  listenClinicSessions,
  listenPatients,
  type PortalPatient,
  type PortalSession,
} from "./data";

export interface ClinicData {
  patients: PortalPatient[];
  sessions: PortalSession[];
  loading: boolean;
  error: string | null;
  /** When the data was last refreshed, for the "live" indicator. */
  updatedAt: number | null;
}

/**
 * Clinic-wide data, kept live by two Firestore listeners.
 *
 * The previous implementation re-fetched the whole roster and then every
 * session for every patient — once per patient-document change and again every
 * thirty seconds. Since the Cloud Function rewrites the patient document on
 * every session, a busy clinic was re-downloading its entire history each time
 * a session landed.
 *
 * Now there are exactly two subscriptions: the roster, and one bounded
 * collection-group query for recent sessions. Both are pushed by Firestore, so
 * there is no polling interval to tune.
 */
export function useClinicData(): ClinicData {
  const [patients, setPatients] = useState<PortalPatient[]>([]);
  const [sessions, setSessions] = useState<PortalSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ready = { patients: false, sessions: false };

    const markReady = (which: keyof typeof ready) => {
      ready[which] = true;
      if (ready.patients && ready.sessions) setLoading(false);
    };

    const fail = (caught: Error) => {
      if (cancelled) return;
      // Keep whatever is already on screen rather than blanking the dashboard.
      setError(String(caught));
      setLoading(false);
    };

    const stopPatients = listenPatients((next) => {
      if (cancelled) return;
      setPatients(next);
      setError(null);
      setUpdatedAt(Date.now());
      markReady("patients");
    }, fail);

    const stopSessions = listenClinicSessions((next) => {
      if (cancelled) return;
      setSessions(next);
      setUpdatedAt(Date.now());
      markReady("sessions");
    }, fail);

    return () => {
      cancelled = true;
      stopPatients();
      stopSessions();
    };
  }, []);

  return { patients, sessions, loading, error, updatedAt };
}
