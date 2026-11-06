import type { CohortRow } from "./analytics";

export type AttentionReason = "Lapsed" | "Declining" | "Stalled";

export interface AttentionItem {
  patientId: string;
  name: string;
  reason: AttentionReason;
  detail: string;
  /** Higher sorts first. */
  severity: number;
}

/** A patient with no session for longer than this is considered lapsed. */
export const LAPSED_DAYS = 21;
/** A drop of this many points between sessions counts as a decline. */
export const DECLINE_POINTS = 10;
/** Sessions needed before "no improvement" is a fair judgement. */
export const STALLED_SESSIONS = 3;

/**
 * Patients a clinician should look at, derived from data already loaded.
 *
 * Deliberately a triage list rather than a chart: the point is to name specific
 * people needing a specific action, which a bar chart would obscure.
 */
export function needsAttention(
  cohort: CohortRow[],
  now: number = Date.now(),
): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const row of cohort) {
    const sessions = row.sessions;
    if (sessions.length === 0) continue;

    const last = sessions[sessions.length - 1];
    const lastAt = Date.parse(last.completed_at ?? "");
    const daysSince = Number.isFinite(lastAt)
      ? (now - lastAt) / 86_400_000
      : null;

    // Lapsed takes priority: nothing else can be assessed without recent data.
    if (daysSince !== null && daysSince > LAPSED_DAYS) {
      items.push({
        patientId: row.patient.id,
        name: row.patient.name,
        reason: "Lapsed",
        detail: `${Math.round(daysSince)} days since the last session`,
        severity: 1000 + Math.round(daysSince),
      });
      continue;
    }

    const lastScore = Number(last.summary?.mean_form_score ?? 0);
    const previous = sessions.length >= 2 ? sessions[sessions.length - 2] : null;
    const previousScore = Number(previous?.summary?.mean_form_score ?? 0);

    if (previous && previousScore > 0 && lastScore > 0 && lastScore <= previousScore - DECLINE_POINTS) {
      items.push({
        patientId: row.patient.id,
        name: row.patient.name,
        reason: "Declining",
        detail: `score fell from ${Math.round(previousScore)}% to ${Math.round(lastScore)}%`,
        severity: 500 + Math.round(previousScore - lastScore),
      });
      continue;
    }

    const firstScore = Number(sessions[0].summary?.mean_form_score ?? 0);
    if (
      sessions.length >= STALLED_SESSIONS &&
      firstScore > 0 &&
      lastScore > 0 &&
      lastScore <= firstScore + 1
    ) {
      items.push({
        patientId: row.patient.id,
        name: row.patient.name,
        reason: "Stalled",
        detail: `no improvement across ${sessions.length} sessions`,
        severity: 100 + sessions.length,
      });
    }
  }

  return items.sort((a, b) => b.severity - a.severity);
}
