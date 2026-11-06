import { SessionView, type SessionDetailLike } from "@pilates/patient-view";
import { Card } from "@pilates/ui";
import type { ClinicalSessionDocument } from "@pilates/types";

export interface SessionDetailPageProps {
  document: ClinicalSessionDocument | null;
  onBack: () => void;
  /** Name of the page the back button returns to. */
  backLabel?: string;
  onNewSession: () => void;
}

/**
 * Full analysis of one session.
 *
 * The page itself lives in `@pilates/patient-view` and is shared with the
 * portal, so both surfaces show the same analysis. This wrapper only adapts the
 * stored document.
 */
export function SessionDetailPage({
  document,
  onBack,
  backLabel = "Patient",
  onNewSession,
}: SessionDetailPageProps) {
  if (!document) {
    return (
      <Card className="p-6 text-sm text-slate-400">
        No session is loaded. Open one from a patient&apos;s history.
      </Card>
    );
  }

  const session: SessionDetailLike = {
    session_id: document.session_id,
    pose_id: document.pose_id,
    completed_at: document.completed_at,
    model_version: document.model_version,
    started_at: document.started_at,
    duration_seconds: document.duration_seconds,
    summary: document.summary,
    reps: document.reps,
    kinematic_curve: document.kinematic_curve,
    research_telemetry: document.research_telemetry ?? null,
  };

  return (
    <SessionView
      session={session}
      onBack={onBack}
      backLabel={backLabel.replace(/^Back to /, "")}
      onNewSession={onNewSession}
    />
  );
}
