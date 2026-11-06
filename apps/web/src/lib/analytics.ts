import type {
  AdherenceRow,
  BmiBandSummary,
  BmiPoint,
  ImprovementRow,
  PoseDifficultyRow,
} from "@pilates/viz";
import { poseDisplayLabel } from "@pilates/types";
import type { PortalPatient, PortalSession } from "./data";

/** One patient plus their sessions, with the derived measurements. */
export interface CohortRow {
  patient: PortalPatient;
  age: number | null;
  weight: number | null;
  height: number | null;
  bmi: number | null;
  gender: string;
  sessions: PortalSession[];
  meanScore: number;
  reps: number;
}

export const BMI_BANDS = [
  { label: "under 18.5", min: 0, max: 18.5 },
  { label: "18.5–24.9", min: 18.5, max: 25 },
  { label: "25–29.9", min: 25, max: 30 },
  { label: "30+", min: 30, max: Number.POSITIVE_INFINITY },
];

/** Parse a free-text measurement, returning null for anything unusable. */
export function toNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Body mass index from stored weight and height.
 *
 * Out-of-range values are treated as data-entry errors rather than real
 * measurements, so one mistyped height cannot distort a whole band.
 */
export function bmiOf(weight: number | null, height: number | null): number | null {
  if (weight === null || height === null) return null;
  if (weight < 20 || weight > 300) return null;
  if (height < 50 || height > 250) return null;
  const metres = height / 100;
  const bmi = weight / (metres * metres);
  return Number.isFinite(bmi) ? bmi : null;
}

function scoreOf(session: PortalSession): number {
  return Number(session.summary?.mean_form_score ?? 0);
}

function completedAtOf(session: PortalSession): string {
  return session.completed_at ?? "";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Group sessions under their patient and derive the measurements once. */
export function buildCohort(
  patients: PortalPatient[],
  sessions: PortalSession[],
): CohortRow[] {
  const byPatient = new Map<string, PortalSession[]>();
  for (const session of sessions) {
    const list = byPatient.get(session.patient_id) ?? [];
    list.push(session);
    byPatient.set(session.patient_id, list);
  }

  return patients.map((patient) => {
    const list = (byPatient.get(patient.id) ?? []).sort(
      (a, b) => Date.parse(completedAtOf(a)) - Date.parse(completedAtOf(b)),
    );
    const scores = list.map(scoreOf).filter((value) => value > 0);
    const weight = toNumber(patient.weight);
    const height = toNumber(patient.height);

    return {
      patient,
      age: toNumber(patient.age),
      weight,
      height,
      bmi: bmiOf(weight, height),
      gender: (patient.gender ?? "").trim(),
      sessions: list,
      meanScore: scores.length
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : 0,
      reps: list.reduce(
        (total, session) => total + Number(session.summary?.total_reps ?? 0),
        0,
      ),
    };
  });
}

/** A patient's sessions, optionally narrowed to one pose. */
function sessionsFor(row: CohortRow, poseId?: string): PortalSession[] {
  return poseId ? row.sessions.filter((session) => session.pose_id === poseId) : row.sessions;
}

/** Poses present in the data, sorted, for the per-chart selectors. */
export function poseOptions(cohort: CohortRow[]): string[] {
  const set = new Set<string>();
  for (const row of cohort) {
    for (const session of row.sessions) {
      if (session.pose_id) set.add(session.pose_id);
    }
  }
  return [...set].sort();
}

/** Spread of session scores per exercise, hardest first. */
export function poseDifficulty(cohort: CohortRow[]): PoseDifficultyRow[] {
  const buckets = new Map<string, number[]>();
  for (const row of cohort) {
    for (const session of row.sessions) {
      const score = scoreOf(session);
      if (score <= 0) continue;
      const list = buckets.get(session.pose_id) ?? [];
      list.push(score);
      buckets.set(session.pose_id, list);
    }
  }

  return [...buckets.entries()]
    .map(([poseId, scores]) => ({
      poseId,
      label: poseDisplayLabel(poseId),
      min: Math.min(...scores),
      max: Math.max(...scores),
      mean: scores.reduce((a, b) => a + b, 0) / scores.length,
      sessions: scores.length,
    }))
    .sort((a, b) => a.mean - b.mean);
}

/** Change between each patient's first and latest session. */
export function improvement(
  cohort: CohortRow[],
  poseId?: string,
): ImprovementRow[] {
  return cohort
    .map((row) => ({ row, sessions: sessionsFor(row, poseId) }))
    .filter(({ sessions }) => sessions.length >= 2)
    .map(({ row, sessions }) => {
      const first = scoreOf(sessions[0]);
      const last = scoreOf(sessions[sessions.length - 1]);
      return {
        patientId: row.patient.id,
        name: row.patient.name,
        delta: last - first,
        first,
        last,
        sessions: sessions.length,
      };
    })
    .sort((a, b) => b.delta - a.delta);
}

export function bmiPoints(cohort: CohortRow[], poseId?: string): BmiPoint[] {
  return cohort
    .map((row) => {
      const scores = sessionsFor(row, poseId)
        .map(scoreOf)
        .filter((value) => value > 0);
      return {
        row,
        mean: scores.length
          ? scores.reduce((a, b) => a + b, 0) / scores.length
          : 0,
      };
    })
    .filter(({ row, mean }) => row.bmi !== null && mean > 0)
    .map(({ row, mean }) => ({
      bmi: row.bmi as number,
      score: mean,
      name: row.patient.name,
    }));
}

export function bmiBands(points: BmiPoint[]): BmiBandSummary[] {
  return BMI_BANDS.map((band) => {
    const rows = points.filter(
      (point) => point.bmi >= band.min && point.bmi < band.max,
    );
    return {
      label: band.label,
      min: band.min,
      max: band.max,
      mean: rows.length
        ? rows.reduce((total, point) => total + point.score, 0) / rows.length
        : 0,
      count: rows.length,
    };
  });
}

/** Sessions per patient, with the median gap between them. */
export function adherence(cohort: CohortRow[], poseId?: string): AdherenceRow[] {
  return cohort
    .map((row) => ({ row, sessions: sessionsFor(row, poseId) }))
    .filter(({ sessions }) => sessions.length > 0)
    .map(({ row, sessions }) => {
      const times = sessions.map((session) => Date.parse(completedAtOf(session)));
      const gaps: number[] = [];
      for (let index = 1; index < times.length; index += 1) {
        const gap = (times[index] - times[index - 1]) / 86_400_000;
        if (Number.isFinite(gap) && gap >= 0) gaps.push(gap);
      }
      return {
        patientId: row.patient.id,
        name: row.patient.name,
        sessions: sessions.length,
        medianGapDays: median(gaps),
      };
    })
    .sort((a, b) => b.sessions - a.sessions);
}
