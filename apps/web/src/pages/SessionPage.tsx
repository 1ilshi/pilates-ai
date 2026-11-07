import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { getDownloadURL, getMetadata, ref } from "firebase/storage";
import { SessionView, type SessionDetailLike } from "@pilates/patient-view";
import { Card } from "@pilates/ui";
import { listenSession, type PortalSession } from "../lib/data";
import { storage } from "../lib/firebase";

function toSessionDetail(session: PortalSession): SessionDetailLike {
  return {
    session_id: session.session_id ?? session.id,
    pose_id: session.pose_id,
    completed_at: session.completed_at,
    model_version: session.model_version,
    started_at: session.started_at,
    duration_seconds: session.duration_seconds,
    summary: session.summary,
    reps: session.reps,
    kinematic_curve: session.kinematic_curve,
    research_telemetry: session.research_telemetry ?? null,
  };
}

/**
 * Portal session analysis.
 *
 * Renders the same `SessionView` as the desktop app. The portal additionally
 * offers the Parquet archive download, which the desktop cannot resolve.
 */
export function SessionPage() {
  const { patientId = "", sessionId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const origin = (location.state as { from?: string } | null)?.from;
  const backLabel = origin ?? "Patient";
  const [session, setSession] = useState<PortalSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // `null` while unknown: the archive is probed once per session rather than
  // offering a download that is certain to 404. Sessions recorded before the
  // bucket was configured carry a storage path but no object.
  const [archiveAvailable, setArchiveAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const stop = listenSession(
      patientId,
      sessionId,
      (record) => {
        if (cancelled) return;
        setSession(record);
        setLoading(false);
      },
      (caught) => {
        if (cancelled) return;
        setError(String(caught));
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
      stop();
    };
  }, [patientId, sessionId]);

  const downloadParquet = async () => {
    const path = session?.research_telemetry?.storage_path;
    if (!path) return;
    setDownloadError(null);
    try {
      const url = await getDownloadURL(ref(storage, path));
      window.open(url, "_blank", "noopener");
    } catch (caught) {
      setArchiveAvailable(false);
      setDownloadError(
        `Could not resolve the archive: ${(caught as Error).message}`,
      );
    }
  };

  // Probe the object once, when the session loads, so the download is only
  // offered when there is something to download.
  useEffect(() => {
    const path = session?.research_telemetry?.storage_path;
    if (!path) {
      setArchiveAvailable(null);
      return;
    }
    let cancelled = false;
    setArchiveAvailable(null);
    getMetadata(ref(storage, path))
      .then(() => {
        if (!cancelled) setArchiveAvailable(true);
      })
      .catch(() => {
        // A missing object is the common case for older sessions; a denied
        // read is indistinguishable here and both mean "do not offer it".
        if (!cancelled) setArchiveAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (error) {
    return (
      <Card className="border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">
        {error}
      </Card>
    );
  }

  if (loading) {
    return <p className="text-sm text-slate-400">Loading session…</p>;
  }

  if (!session) {
    return <Card className="p-6 text-sm text-slate-400">Session not found.</Card>;
  }

  return (
    <div className="space-y-4">
      {downloadError && (
        <Card className="border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">
          {downloadError}
        </Card>
      )}
      {archiveAvailable === false && (
        <Card className="border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
          This session has no stored telemetry archive — it was recorded before
          archiving was enabled. The analysis above is unaffected.
        </Card>
      )}
      <SessionView
        session={toSessionDetail(session)}
        onBack={() =>
          origin ? navigate(-1) : navigate(`/patients/${patientId}`)
        }
        backLabel={backLabel}
        onDownloadTelemetry={archiveAvailable ? downloadParquet : undefined}
      />
    </div>
  );
}
