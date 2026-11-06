import type { SegmentBar } from "@pilates/viz";
import type { CohortRow } from "./analytics";
import { toNumber } from "./analytics";

/** A named cohort: the portal's only patient-selection concept. */
export interface Cohort {
  id: string;
  name: string;
  /** Unselected cohorts keep their criteria but are excluded from the charts. */
  enabled: boolean;
  ageMin: string;
  ageMax: string;
  weightMin: string;
  weightMax: string;
  heightMin: string;
  heightMax: string;
  bmiMin: string;
  bmiMax: string;
  gender: string;
}

export const MAX_COHORTS = 4;
export const COHORT_COLORS = ["#2dd4bf", "#60a5fa", "#f472b6", "#34d399"];

/** min key, max key, short label rendered inline before the pair. */
export const COHORT_RANGES: Array<[keyof Cohort, keyof Cohort, string]> = [
  ["ageMin", "ageMax", "Age"],
  ["bmiMin", "bmiMax", "BMI"],
  ["weightMin", "weightMax", "Weight"],
  ["heightMin", "heightMax", "Height"],
];

const STORAGE_KEY = "pilates.portal.cohorts.v1";

export function emptyCohort(index: number): Cohort {
  return {
    id: `cohort-${Date.now()}-${index}`,
    name: `Cohort ${index + 1}`,
    enabled: true,
    ageMin: "",
    ageMax: "",
    weightMin: "",
    weightMax: "",
    heightMin: "",
    heightMax: "",
    bmiMin: "",
    bmiMax: "",
    gender: "",
  };
}

function within(value: number | null, min: string, max: string): boolean {
  const low = toNumber(min);
  const high = toNumber(max);
  // A missing measurement cannot satisfy an active numeric filter.
  if (low !== null && (value === null || value < low)) return false;
  if (high !== null && (value === null || value > high)) return false;
  return true;
}

export function matchesCohort(row: CohortRow, cohort: Cohort): boolean {
  return (
    within(row.age, cohort.ageMin, cohort.ageMax) &&
    within(row.weight, cohort.weightMin, cohort.weightMax) &&
    within(row.height, cohort.heightMin, cohort.heightMax) &&
    within(row.bmi, cohort.bmiMin, cohort.bmiMax) &&
    (cohort.gender === "" ||
      row.gender.toLowerCase() === cohort.gender.toLowerCase())
  );
}

/** True when every criterion is blank — such a cohort matches everyone. */
export function isCohortEmpty(cohort: Cohort): boolean {
  return (
    cohort.ageMin === "" &&
    cohort.ageMax === "" &&
    cohort.weightMin === "" &&
    cohort.weightMax === "" &&
    cohort.heightMin === "" &&
    cohort.heightMax === "" &&
    cohort.bmiMin === "" &&
    cohort.bmiMax === "" &&
    cohort.gender === ""
  );
}

/**
 * Cohorts are a local viewing preference, so they live in `localStorage` —
 * unlike the desktop's file, the portal has no application data directory.
 * They survive a reload or a browser restart; a corrupt value falls back to
 * "no cohorts" rather than breaking the page.
 */
export function loadCohorts(): Cohort[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Cohort[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Cohort => Boolean(entry) && typeof entry.id === "string")
      .slice(0, MAX_COHORTS)
      .map((entry) => ({ ...emptyCohort(0), ...entry, enabled: entry.enabled !== false }));
  } catch {
    return [];
  }
}

export function saveCohorts(cohorts: Cohort[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cohorts));
  } catch {
    // Storage full or blocked: the page still works, it just will not persist.
  }
}

/** Cohorts currently included in the charts. */
export function enabledCohorts(cohorts: Cohort[]): Cohort[] {
  return cohorts.filter((cohort) => cohort.enabled !== false);
}

/** Resolve cohorts into matchers, falling back to the whole clinic. */
function cohortEntries(
  cohorts: Cohort[],
): Array<{ id: string; label: string; matches: (row: CohortRow) => boolean }> {
  const active = cohorts.filter((cohort) => cohort.enabled !== false);
  return active.length === 0
    ? [{ id: "all", label: "All patients", matches: () => true }]
    : active.map((entry, index) => ({
        id: entry.id,
        label: entry.name.trim() || `Cohort ${index + 1}`,
        matches: (row: CohortRow) => matchesCohort(row, entry),
      }));
}

/** Every repetition's measurements, per cohort, for the scatter view. */
export interface CohortRawValues {
  id: string;
  label: string;
  color: string;
  /** One value per repetition. */
  scores: number[];
  /** One value per session average, for the session-weighted scatter. */
  sessionScores: number[];
  holds: number[];
}

export function cohortValues(
  cohorts: Cohort[],
  cohort: CohortRow[],
  poseId?: string,
): CohortRawValues[] {
  return cohortEntries(cohorts).map((entry, index) => {
    const rows = cohort.filter((row) => entry.matches(row));
    const sessions = rows
      .flatMap((row) => row.sessions)
      .filter((session) => !poseId || session.pose_id === poseId);

    const scores: number[] = [];
    const sessionScores: number[] = [];
    const holds: number[] = [];
    for (const session of sessions) {
      const sessionScore = Number(session.summary?.mean_form_score ?? 0);
      if (sessionScore > 0) sessionScores.push(sessionScore);
      for (const rep of session.reps ?? []) {
        const score = Number(rep.form_score ?? 0);
        if (Number.isFinite(score) && score > 0) scores.push(score);
        const duration = Number(rep.duration_sec ?? 0);
        if (duration > 0) holds.push(duration);
      }
    }

    return {
      id: entry.id,
      label: entry.label,
      color: COHORT_COLORS[index % COHORT_COLORS.length],
      scores,
      sessionScores,
      holds,
    };
  });
}

/** Everything the cohort comparison block plots. */
export interface CohortBars {
  /** Mean of every repetition — rep-weighted. */
  formScoreByRep: SegmentBar[];
  /** Mean of session averages — session-weighted. */
  formScoreBySession: SegmentBar[];
  holdPerRep: SegmentBar[];
  /** Session counts, annotated with reps per session. */
  sessions: SegmentBar[];
  /** Sessions against reps-per-session, for the density scatter. */
  scatter: Array<{ id: string; label: string; color: string; x: number; y: number }>;
}

/** One bar per cohort for each comparison metric. */
export function cohortBars(
  cohorts: Cohort[],
  cohort: CohortRow[],
  poseId?: string,
): CohortBars {
  const formScoreByRep: SegmentBar[] = [];
  const formScoreBySession: SegmentBar[] = [];
  const holdPerRep: SegmentBar[] = [];
  const sessions: SegmentBar[] = [];
  const scatter: CohortBars["scatter"] = [];

  cohortEntries(cohorts).forEach((entry, index) => {
    const color = COHORT_COLORS[index % COHORT_COLORS.length];
    const rows = cohort.filter((row) => entry.matches(row));

    // Pose is chosen separately from the cohort: it narrows what is measured,
    // not who is included.
    const scopedSessions = rows
      .flatMap((row) => row.sessions)
      .filter((session) => !poseId || session.pose_id === poseId);

    const repScores: number[] = [];
    const sessionScores: number[] = [];
    const durations: number[] = [];
    let repTotal = 0;

    for (const session of scopedSessions) {
      repTotal += Number(session.summary?.total_reps ?? 0);
      const sessionScore = Number(session.summary?.mean_form_score ?? 0);
      if (sessionScore > 0) sessionScores.push(sessionScore);
      for (const rep of session.reps ?? []) {
        const score = Number(rep.form_score ?? 0);
        if (Number.isFinite(score) && score > 0) repScores.push(score);
        const duration = Number(rep.duration_sec ?? 0);
        if (duration > 0) durations.push(duration);
      }
    }

    const patients = rows.filter((row) => row.sessions.length > 0).length;
    const sessionCount = scopedSessions.length;
    const mean = (values: number[]) =>
      values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const density = sessionCount > 0 ? repTotal / sessionCount : 0;

    const base = { id: entry.id, label: entry.label, color, patients, sessions: sessionCount };

    formScoreByRep.push({ ...base, value: mean(repScores) });
    formScoreBySession.push({ ...base, value: mean(sessionScores) });
    holdPerRep.push({ ...base, value: mean(durations) });
    sessions.push({
      ...base,
      value: sessionCount,
      note: `${sessionCount} · ${density.toFixed(1)} reps/session`,
    });
    scatter.push({
      id: entry.id,
      label: entry.label,
      color,
      x: sessionCount,
      y: density,
    });
  });

  return { formScoreByRep, formScoreBySession, holdPerRep, sessions, scatter };
}
