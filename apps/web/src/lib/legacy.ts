export interface LegacyPoseSummary {
  count: number;
  avg: number;
  min: number;
  max: number;
  seconds: number;
  last_sample_at: string | null;
}

/** Frozen statistics from the previous application. Never updated. */
export interface LegacySummary {
  source: string;
  frozen_at: string;
  last_sample_at: string | null;
  total_samples: number;
  comments_count: number;
  poses: Record<string, LegacyPoseSummary>;
}

/**
 * Parse the materialised `legacy_json` field written by
 * `tools/materialize_legacy.py`.
 *
 * Returns `null` when absent or malformed: a display panel must never break the
 * page because of bad data.
 */
export function parseLegacy(raw: unknown): LegacySummary | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LegacySummary>;
    if (!parsed || typeof parsed !== "object" || !parsed.poses) return null;
    return {
      source: parsed.source ?? "legacy",
      frozen_at: parsed.frozen_at ?? "",
      last_sample_at: parsed.last_sample_at ?? null,
      total_samples: Number(parsed.total_samples ?? 0),
      comments_count: Number(parsed.comments_count ?? 0),
      poses: parsed.poses as Record<string, LegacyPoseSummary>,
    };
  } catch {
    return null;
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso).slice(0, 10);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
