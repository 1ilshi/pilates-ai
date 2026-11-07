import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  MessageSquare,
  ChevronRight,
  ExternalLink,
  History,
  Pencil,
  Play,
  Snowflake,
  User,
  Check,
  X,
} from "lucide-react";
import {
  ConsistencyChart,
  HoldQualityScatter,
  RepProfileChart,
  SessionMetricChart,
  poseColor,
  type SessionMetric,
} from "@pilates/viz";
import { poseDisplayLabel } from "@pilates/types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatPercent,
} from "@pilates/ui";
import type {
  LegacySummary,
  PatientViewProps,
  ProfileDraft,
  SessionLike,
} from "./types";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function toNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((Date.now() - at) / 86_400_000));
}

function bmiOf(weight: string, height: string): number | null {
  const kg = toNumber(weight);
  const cm = toNumber(height);
  if (kg === null || cm === null) return null;
  if (kg < 20 || kg > 300 || cm < 50 || cm > 250) return null;
  const metres = cm / 100;
  return kg / (metres * metres);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function scoreOf(session: SessionLike): number {
  return Number(session.summary?.mean_form_score ?? 0);
}

function meanRepSeconds(session: SessionLike | undefined): number {
  if (!session) return 0;
  const durations = (session.reps ?? [])
    .map((rep) => Number(rep.duration_sec ?? 0))
    .filter((value) => value > 0);
  return durations.length
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : 0;
}

const METRICS: Array<{ metric: SessionMetric; label: string }> = [
  { metric: "form_score", label: "Form score per session" },
  { metric: "avg_hold_seconds", label: "Hold time per rep, per session" },
  { metric: "reps", label: "Repetitions per session" },
];

const PROFILE_FIELDS: Array<[keyof ProfileDraft, string]> = [
  ["name", "Name"],
  ["gender", "Gender"],
  ["age", "Age"],
  ["weight", "Weight"],
  ["height", "Height"],
  ["address", "Address"],
  ["telNumber", "Phone"],
];

// `firestore.rules` rejects notes longer than 4000 characters, so the composer
// stops at the same limit: over-length text used to be accepted here, sent, and
// then silently refused by the server.
const COMMENT_MAX_LENGTH = 4000;
// Only surface the counter once the note is long enough for the limit to matter.
const COMMENT_COUNTER_FROM = 3500;
// Amber from here on, so running out of room is visible before it happens.
const COMMENT_COUNTER_WARN = COMMENT_MAX_LENGTH - 100;

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-right text-sm text-slate-200">{value || "—"}</span>
    </div>
  );
}

function Snapshot({
  label,
  value,
  hint,
  delta,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: number | null;
}) {
  const showDelta = typeof delta === "number" && Number.isFinite(delta);
  return (
    <Card className="p-4">
      <p className="text-xs text-slate-400">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <p className="text-2xl font-bold text-slate-50">{value}</p>
        {showDelta && Math.abs(delta) >= 0.5 && (
          <span
            className={
              delta > 0
                ? "text-xs font-medium text-emerald-400"
                : "text-xs font-medium text-amber-400"
            }
          >
            {delta > 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(0)}
          </span>
        )}
      </div>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

function Section({
  title,
  icon,
  count,
  open,
  onToggle,
  children,
  actions,
}: {
  title: string;
  icon: React.ReactNode;
  count?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className={open ? "pb-0" : undefined}>
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="flex items-center gap-2 text-left"
          >
            {open ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
            )}
            <CardTitle className="flex items-center gap-2">
              <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                {icon}
              </span>
              {title}
              {count && <Badge variant="neutral">{count}</Badge>}
            </CardTitle>
          </button>
          {actions}
        </div>
      </CardHeader>
      {open && <CardContent className="pt-4">{children}</CardContent>}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

/**
 * Patient record, shared by the desktop app and the portal.
 *
 * Both surfaces render this component so the clinical view cannot drift. The
 * only difference is `editable`: the portal passes `false`, which hides the
 * edit affordance entirely rather than disabling it.
 */
export function PatientView({
  patient,
  sessions,
  comments = [],
  legacy,
  editable,
  onBack,
  backLabel = "Patients",
  onStartSession,
  onSaveProfile,
  onOpenSession,
  onAddComment,
  onDeleteComment,
}: PatientViewProps) {
  const [pose, setPose] = useState<string>("");
  const [mechanicsOpen, setMechanicsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft>({
    name: "",
    gender: "",
    age: "",
    weight: "",
    height: "",
    address: "",
    telNumber: "",
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [profileSessionId, setProfileSessionId] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);

  const ordered = useMemo(
    () =>
      [...sessions].sort(
        (a, b) => Date.parse(a.completed_at) - Date.parse(b.completed_at),
      ),
    [sessions],
  );

  const poses = useMemo(() => {
    const set = new Set<string>();
    for (const session of ordered) if (session.pose_id) set.add(session.pose_id);
    return [...set].sort();
  }, [ordered]);

  useEffect(() => {
    if (pose && poses.includes(pose)) return;
    // Default to the pose of the most recent session, not the alphabetically
    // first one: the snapshot should describe what was actually done last.
    const latestPose = ordered[ordered.length - 1]?.pose_id;
    setPose(latestPose && poses.includes(latestPose) ? latestPose : (poses[0] ?? ""));
  }, [poses, pose, ordered]);

  const poseSessions = useMemo(
    () => ordered.filter((session) => session.pose_id === pose),
    [ordered, pose],
  );

  useEffect(() => {
    if (profileSessionId && poseSessions.some((s) => s.session_id === profileSessionId)) {
      return;
    }
    setProfileSessionId(poseSessions[poseSessions.length - 1]?.session_id ?? "");
  }, [poseSessions, profileSessionId]);

  /* ---- derived numbers ---- */
  const latest = poseSessions[poseSessions.length - 1];
  const previous = poseSessions[poseSessions.length - 2];

  const latestScore = latest ? scoreOf(latest) : 0;
  const previousScore = previous ? scoreOf(previous) : 0;
  const scoreDelta =
    latest && previous && previousScore > 0 && latestScore > 0
      ? latestScore - previousScore
      : null;

  const latestHold = meanRepSeconds(latest);
  const previousHold = meanRepSeconds(previous);
  const holdDelta =
    latest && previous && previousHold > 0 && latestHold > 0
      ? latestHold - previousHold
      : null;

  const totalReps = poseSessions.reduce(
    (sum, session) => sum + Number(session.summary?.total_reps ?? 0),
    0,
  );
  const repsPerSession = poseSessions.length
    ? totalReps / poseSessions.length
    : 0;

  const last30 = ordered.filter((session) => {
    const at = Date.parse(session.completed_at);
    return Number.isFinite(at) && Date.now() - at <= 30 * 86_400_000;
  });
  const gaps: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const gap =
      (Date.parse(ordered[index].completed_at) -
        Date.parse(ordered[index - 1].completed_at)) /
      86_400_000;
    if (Number.isFinite(gap) && gap >= 0) gaps.push(gap);
  }
  const medianGap = median(gaps);

  const sessionBars = useMemo(
    () =>
      poseSessions.map((session, index) => {
        const reps = session.reps ?? [];
        const totalHold = reps.reduce(
          (sum, rep) => sum + Number(rep.duration_sec ?? 0),
          0,
        );
        return {
          label: `Session ${index + 1}`,
          at: session.completed_at,
          form_score: scoreOf(session),
          avg_hold_seconds: reps.length ? totalHold / reps.length : 0,
          reps: reps.length || Number(session.summary?.total_reps ?? 0),
        };
      }),
    [poseSessions],
  );

  const profileReps = useMemo(() => {
    const session = poseSessions.find((item) => item.session_id === profileSessionId);
    return (session?.reps ?? []).map((rep) => ({
      rep_index: rep.rep_index,
      duration_sec: Number(rep.duration_sec ?? 0),
      form_score: Number(rep.form_score ?? 0),
    }));
  }, [poseSessions, profileSessionId]);

  const holdQuality = useMemo(
    () =>
      poseSessions.flatMap((session) =>
        (session.reps ?? []).map((rep) => ({
          hold: Number(rep.duration_sec ?? 0),
          score: Number(rep.form_score ?? 0),
          sessionLabel: session.session_id.slice(0, 8),
        })),
      ),
    [poseSessions],
  );

  const consistency = useMemo(
    () =>
      poseSessions.map((session, index) => {
        const scores = (session.reps ?? []).map((rep) => Number(rep.form_score ?? 0));
        return {
          label: `Session ${index + 1}`,
          at: session.completed_at,
          min: scores.length ? Math.min(...scores) : 0,
          max: scores.length ? Math.max(...scores) : 0,
          mean: scores.length
            ? scores.reduce((a, b) => a + b, 0) / scores.length
            : 0,
          count: scores.length,
        };
      }),
    [poseSessions],
  );

  /* ---- status ---- */
  const lastAt = ordered[ordered.length - 1]?.completed_at ?? patient.lastActive;
  const sinceDays = daysSince(lastAt);
  const lapsed = sinceDays !== null && sinceDays > 21;
  const declining = scoreDelta !== null && scoreDelta <= -10;
  const stalled =
    ordered.length >= 3 &&
    scoreOf(ordered[ordered.length - 1]) > 0 &&
    scoreOf(ordered[0]) > 0 &&
    scoreOf(ordered[ordered.length - 1]) <= scoreOf(ordered[0]) + 1;

  const bmi = bmiOf(patient.weight, patient.height);
  const legacyRows: Array<[string, LegacySummary["poses"][string]]> = legacy
    ? Object.entries(legacy.poses).sort(([a], [b]) => a.localeCompare(b))
    : [];

  /* ---- profile editing ---- */
  const startEdit = () => {
    setDraft({
      name: patient.name,
      gender: patient.gender ?? "",
      age: patient.age ?? "",
      weight: patient.weight ?? "",
      height: patient.height ?? "",
      address: patient.address ?? "",
      telNumber: patient.telNumber ?? "",
    });
    setSaveError(null);
    setEditing(true);
  };

  const saveProfile = async () => {
    if (!onSaveProfile) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSaveProfile(draft);
      setEditing(false);
    } catch (error) {
      setSaveError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const submitComment = async () => {
    if (!onAddComment) return;
    const text = commentDraft.trim();
    if (!text) return;
    setCommentBusy(true);
    setCommentError(null);
    try {
      await onAddComment(text);
      setCommentDraft("");
    } catch (error) {
      setCommentError(String(error));
    } finally {
      setCommentBusy(false);
    }
  };

  const removeComment = async (id: string) => {
    if (!onDeleteComment) return;
    setCommentBusy(true);
    setCommentError(null);
    try {
      await onDeleteComment(id);
    } catch (error) {
      setCommentError(String(error));
    } finally {
      setCommentBusy(false);
    }
  };

  const toggleRow = (sessionId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });

  return (
    <div className="space-y-5">
      {/* Header ------------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="mb-1 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              {backLabel}
            </button>
          )}
          <h3 className="text-xl font-semibold text-slate-100">{patient.name}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {ordered.length > 0 && <Badge variant="brand">Active program</Badge>}
            {legacy && <Badge variant="warning">Legacy history</Badge>}
            {lapsed && <Badge variant="danger">Lapsed {sinceDays}d</Badge>}
            {declining && <Badge variant="warning">Declining</Badge>}
            {stalled && <Badge variant="neutral">Stalled</Badge>}
            {ordered.length === 0 && !legacy && (
              <Badge variant="neutral">No history</Badge>
            )}
          </div>
        </div>

        {onStartSession && (
          <Button onClick={onStartSession}>
            <Play className="h-4 w-4" aria-hidden="true" />
            Start session
          </Button>
        )}
      </div>

      {/* Snapshot ----------------------------------------------------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Snapshot
          label="Latest form score"
          value={latestScore ? formatPercent(latestScore, 0) : "—"}
          hint={latest ? poseDisplayLabel(pose) : "no sessions"}
          delta={scoreDelta}
        />
        <Snapshot
          label="Hold time per rep"
          value={latestHold ? `${latestHold.toFixed(1)}s` : "—"}
          hint="mean across the latest session"
          delta={holdDelta}
        />
        <Snapshot
          label="Sessions & reps"
          value={String(poseSessions.length)}
          hint={`${repsPerSession.toFixed(1)} reps per session`}
        />
        <Snapshot
          label="Adherence"
          value={String(last30.length)}
          hint={
            medianGap !== null
              ? `${last30.length} in last 30 days · ~${Math.round(medianGap)}d gap`
              : "no gap recorded yet"
          }
        />
      </div>

      {/* The pose selector spans the full width so the chart column and
          the profile column start at the same top edge. */}
        {poses.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {poses.map((poseId, index) => {
              const selected = pose === poseId;
              const color = poseColor(poseId, index);
              return (
                <button
                  key={poseId}
                  type="button"
                  onClick={() => setPose(poseId)}
                  aria-pressed={selected}
                  title={poseDisplayLabel(poseId)}
                  className={
                    selected
                      ? "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium"
                      : "inline-flex items-center gap-2 rounded-full border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200"
                  }
                  style={
                    selected
                      ? { borderColor: color, backgroundColor: `${color}22`, color }
                      : undefined
                  }
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  {poseDisplayLabel(poseId)}
                </button>
              );
            })}
          </div>
        )}

      {/* Programme + profile ------------------------------------------ */}
      <div className="grid grid-cols-1 gap-4 md:min-h-[600px] md:grid-cols-3">
        <div className="space-y-3 md:col-span-2">
          {poseSessions.length > 0 ? (
            <div className="space-y-3">
              {METRICS.map((entry) => (
                <Card key={entry.metric} className="p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-medium text-slate-300">{entry.label}</p>
                    <p className="text-xs text-slate-500">
                      {poseSessions.length} session(s)
                    </p>
                  </div>
                  <SessionMetricChart points={sessionBars} metric={entry.metric} />
                </Card>
              ))}
            </div>
          ) : (
            <Card className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
              <History className="h-6 w-6 text-slate-600" aria-hidden="true" />
              <p className="text-sm text-slate-400">No sessions recorded yet</p>
              <p className="text-xs text-slate-500">
                Start a session to begin building this patient&apos;s programme.
              </p>
            </Card>
          )}
        </div>

        <div className="md:relative">
        <div className="flex flex-col gap-3 md:absolute md:inset-0">
        <Card className="shrink-0">
          <CardHeader className="pb-0">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2">
                <User className="h-4 w-4 text-brand-400" aria-hidden="true" />
                Profile
              </CardTitle>
              {editable && onSaveProfile && !editing && (
                <button
                  type="button"
                  onClick={startEdit}
                  className="inline-flex items-center gap-1 text-xs text-slate-400 transition-colors hover:text-slate-200"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  Edit
                </button>
              )}
            </div>
          </CardHeader>
          <CardContent className="divide-y divide-slate-800">
            {editing ? (
              <div className="space-y-2 py-2">
                {PROFILE_FIELDS.map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 text-xs text-slate-500">
                    <span className="w-14 shrink-0">{label}</span>
                    <input
                      value={draft[key]}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, [key]: event.target.value }))
                      }
                      aria-label={label}
                      className="h-8 min-w-0 flex-1 rounded-control border border-slate-700 bg-slate-950 px-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none"
                    />
                  </label>
                ))}
                {saveError && <p className="text-xs text-red-400">{saveError}</p>}
                <div className="flex gap-2 pt-1">
                  <Button onClick={() => void saveProfile()} disabled={saving}>
                    <Check className="h-4 w-4" aria-hidden="true" />
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
                    <X className="h-4 w-4" aria-hidden="true" />
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <Detail label="Gender" value={patient.gender} />
                <Detail label="Age" value={patient.age} />
                <Detail label="Weight" value={patient.weight ? `${patient.weight} kg` : ""} />
                <Detail label="Height" value={patient.height ? `${patient.height} cm` : ""} />
                <Detail label="BMI" value={bmi !== null ? bmi.toFixed(1) : ""} />
                {patient.telNumber && (
                  <Detail label="Phone" value={patient.telNumber} />
                )}
                {patient.address && (
                  <Detail label="Address" value={patient.address} />
                )}
                {patient.createdAt && (
                  <Detail label="Patient since" value={formatDate(patient.createdAt)} />
                )}
                <Detail
                  label="Last session"
                  value={
                    lastAt
                      ? `${formatDate(lastAt)}${sinceDays !== null ? ` · ${sinceDays}d ago` : ""}`
                      : ""
                  }
                />
              </>
            )}
          </CardContent>
        </Card>

        {/* Takes whatever height the profile leaves, and scrolls internally so
            a long history never pushes the page down. */}
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="pb-0">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <MessageSquare className="h-4 w-4 text-brand-400" aria-hidden="true" />
                Clinical notes
              </CardTitle>
              <Badge variant="neutral">{comments.length}</Badge>
            </div>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-3 pt-4">
            {onAddComment && (
              <div className="rounded-card border border-slate-800 bg-slate-900/40 transition-colors focus-within:border-brand-500/60">
                <textarea
                  value={commentDraft}
                  onChange={(event) => setCommentDraft(event.target.value)}
                  rows={2}
                  maxLength={COMMENT_MAX_LENGTH}
                  placeholder="Add a note for the next session…"
                  aria-label="New clinical note"
                  className="w-full resize-none bg-transparent px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none"
                />
                <div className="flex items-center justify-between gap-2 border-t border-slate-800/70 px-2 py-1.5">
                  <div className="flex min-w-0 items-center gap-2 pl-1">
                    <span className="truncate text-[10px] text-slate-600">
                      Visible to everyone in the clinic
                    </span>
                    {commentDraft.length > COMMENT_COUNTER_FROM && (
                      <span
                        className={
                          commentDraft.length >= COMMENT_COUNTER_WARN
                            ? "shrink-0 text-[10px] tabular-nums text-amber-400"
                            : "shrink-0 text-[10px] tabular-nums text-slate-500"
                        }
                      >
                        {commentDraft.length}/{COMMENT_MAX_LENGTH}
                      </span>
                    )}
                  </div>
                  <Button
                    onClick={() => void submitComment()}
                    disabled={commentBusy || !commentDraft.trim()}
                  >
                    {commentBusy ? "Saving…" : "Add note"}
                  </Button>
                </div>
              </div>
            )}

            {commentError && <p className="text-xs text-red-400">{commentError}</p>}

            <div className="max-h-80 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 md:max-h-none">
              {comments.length === 0 ? (
                <div className="flex h-full min-h-24 flex-col items-center justify-center gap-1 rounded-card border border-dashed border-slate-800 text-center">
                  <p className="text-xs text-slate-500">No notes yet</p>
                  <p className="text-[11px] text-slate-600">
                    Anything the next session should know.
                  </p>
                </div>
              ) : (
                comments.map((comment) => (
                  <div
                    key={comment.id}
                    className="group rounded-card border border-slate-800/80 bg-slate-900/30 p-3 transition-colors hover:border-slate-700"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                        {formatDateTime(comment.created_at)}
                      </p>
                      {onDeleteComment && (
                        <button
                          type="button"
                          onClick={() => void removeComment(comment.id)}
                          disabled={commentBusy}
                          aria-label="Delete note"
                          className="shrink-0 rounded p-0.5 text-slate-600 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-200">
                      {comment.text}
                    </p>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
        </div>
        </div>
      </div>

      {/* Last session -------------------------------------------------- */}
      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="text-sm">Last session</CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            What was actually done, before planning the next one.
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          {ordered.length === 0 ? (
            <p className="text-xs text-slate-500">Nothing recorded yet.</p>
          ) : (
            (() => {
              const last = ordered[ordered.length - 1];
              return (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-slate-200">
                        {poseDisplayLabel(last.pose_id)}
                      </p>
                      <p className="text-xs text-slate-500">
                        {formatDateTime(last.completed_at)}
                      </p>
                    </div>
                    {onOpenSession && (
                      <Button variant="ghost" onClick={() => onOpenSession(last)}>
                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        Open full analysis
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="rounded-card border border-slate-800 bg-slate-900/40 p-2">
                      <p className="text-xs text-slate-500">Reps</p>
                      <p className="text-lg font-semibold text-slate-100">
                        {last.summary?.total_reps ?? 0}
                      </p>
                    </div>
                    <div className="rounded-card border border-slate-800 bg-slate-900/40 p-2">
                      <p className="text-xs text-slate-500">Mean score</p>
                      <p className="text-lg font-semibold text-slate-100">
                        {scoreOf(last) ? formatPercent(scoreOf(last), 0) : "—"}
                      </p>
                    </div>
                    <div className="rounded-card border border-slate-800 bg-slate-900/40 p-2">
                      <p className="text-xs text-slate-500">Hold per rep</p>
                      <p className="text-lg font-semibold text-slate-100">
                        {meanRepSeconds(last) ? `${meanRepSeconds(last).toFixed(1)}s` : "—"}
                      </p>
                    </div>
                    <div className="rounded-card border border-slate-800 bg-slate-900/40 p-2">
                      <p className="text-xs text-slate-500">Completion</p>
                      <p className="text-lg font-semibold text-slate-100">
                        {last.summary?.completion_rate !== undefined
                          ? formatPercent(last.summary.completion_rate, 0)
                          : "—"}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })()
          )}
        </CardContent>
      </Card>

      {/* Rep mechanics -------------------------------------------------- */}
      {poseSessions.length > 0 && (
        <Section
          title="Rep mechanics"
          icon={<History className="h-4 w-4 text-brand-400" aria-hidden="true" />}
          open={mechanicsOpen}
          onToggle={() => setMechanicsOpen((open) => !open)}
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-500">
                Form and hold across repetitions within one session.
              </p>
              <select
                value={profileSessionId}
                onChange={(event) => setProfileSessionId(event.target.value)}
                aria-label="Select session for the repetition profile"
                className="h-8 rounded-control border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100 focus:border-brand-500 focus:outline-none"
              >
                {poseSessions.map((session, index) => (
                  <option key={session.session_id} value={session.session_id}>
                    Session {index + 1} · {formatDateTime(session.completed_at)}
                  </option>
                ))}
              </select>
            </div>
            <RepProfileChart reps={profileReps} />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div>
                <p className="mb-2 text-xs font-medium text-slate-400">
                  Hold duration vs form
                </p>
                <HoldQualityScatter points={holdQuality} />
              </div>
              <div>
                <p className="mb-2 text-xs font-medium text-slate-400">Rep consistency</p>
                <ConsistencyChart points={consistency} />
              </div>
            </div>
          </div>
        </Section>
      )}

      {/* Session history ------------------------------------------------ */}
      <Section
        title="Sessions"
        icon={<History className="h-4 w-4 text-brand-400" aria-hidden="true" />}
        count={String(ordered.length)}
        open={sessionsOpen}
        onToggle={() => setSessionsOpen((open) => !open)}
      >
        {ordered.length === 0 ? (
          <p className="py-3 text-xs text-slate-500">No sessions recorded yet.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {[...ordered].reverse().map((session) => {
              const isOpen = expanded.has(session.session_id);
              return (
                <li key={session.session_id}>
                  <button
                    type="button"
                    onClick={() => toggleRow(session.session_id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-3 py-3 text-left transition-colors hover:bg-slate-900/40"
                  >
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-200">
                        {poseDisplayLabel(session.pose_id)}
                      </p>
                      <p className="text-xs text-slate-500">
                        {formatDateTime(session.completed_at)}
                      </p>
                    </div>
                    <div className="hidden shrink-0 gap-6 text-right sm:flex">
                      <div>
                        <p className="text-xs text-slate-500">Reps</p>
                        <p className="text-sm text-slate-200">
                          {session.summary?.total_reps ?? 0}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-500">Score</p>
                        <p className="text-sm text-slate-200">
                          {scoreOf(session) ? formatPercent(scoreOf(session), 0) : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-500">Duration</p>
                        <p className="text-sm text-slate-200">
                          {session.duration_seconds
                            ? `${Math.round(session.duration_seconds)}s`
                            : "—"}
                        </p>
                      </div>
                    </div>
                    {session.upload_state && (
                      <Badge variant={session.upload_state === "synced" ? "success" : "neutral"}>
                        {session.upload_state}
                      </Badge>
                    )}
                  </button>

                  {isOpen && (
                    <div className="space-y-3 pb-4 pl-7">
                      {(session.reps ?? []).length > 0 ? (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>#</TableHead>
                              <TableHead>Duration</TableHead>
                              <TableHead>Peak ROM</TableHead>
                              <TableHead>Form</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(session.reps ?? []).map((rep) => (
                              <TableRow key={rep.rep_index}>
                                <TableCell className="text-slate-400">
                                  {rep.rep_index}
                                </TableCell>
                                <TableCell className="text-slate-400">
                                  {Number(rep.duration_sec ?? 0).toFixed(1)}s
                                </TableCell>
                                <TableCell className="text-slate-400">
                                  {Number(rep.peak_rom_angle ?? 0).toFixed(1)}°
                                </TableCell>
                                <TableCell>
                                  {formatPercent(Number(rep.form_score ?? 0), 0)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      ) : (
                        <p className="text-xs text-slate-500">
                          No per-repetition detail recorded for this session.
                        </p>
                      )}
                      {onOpenSession && (
                        <Button variant="ghost" onClick={() => onOpenSession(session)}>
                          <ExternalLink className="h-4 w-4" aria-hidden="true" />
                          Open full analysis
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* Legacy --------------------------------------------------------- */}
      {legacy ? (
        <Card>
          <CardHeader className="pb-0">
            <CardTitle className="flex items-center gap-2">
              <Snowflake className="h-4 w-4 text-amber-400" aria-hidden="true" />
              Legacy history
              <Badge variant="warning">Read-only</Badge>
            </CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              Recorded by the previous application. Last sample{" "}
              {formatDate(legacy.last_sample_at)} — these figures are frozen and will
              not update. They measure classification <em>accuracy</em>, a different
              metric from the form score above.
            </p>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-card border border-slate-800 bg-slate-900/40 p-3">
                <p className="text-xs text-slate-500">Samples</p>
                <p className="text-xl font-bold text-slate-100">{legacy.total_samples}</p>
              </div>
              <div className="rounded-card border border-slate-800 bg-slate-900/40 p-3">
                <p className="text-xs text-slate-500">Poses recorded</p>
                <p className="text-xl font-bold text-slate-100">{legacyRows.length}</p>
              </div>
              <div className="rounded-card border border-slate-800 bg-slate-900/40 p-3">
                <p className="text-xs text-slate-500">Comments</p>
                <p className="text-xl font-bold text-slate-100">{legacy.comments_count}</p>
              </div>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pose</TableHead>
                  <TableHead>Samples</TableHead>
                  <TableHead>Avg accuracy</TableHead>
                  <TableHead>Range</TableHead>
                  <TableHead>Last sample</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {legacyRows.map(([poseId, row]) => (
                  <TableRow key={poseId}>
                    <TableCell className="font-medium">
                      {poseDisplayLabel(poseId)}
                    </TableCell>
                    <TableCell className="text-slate-400">{row.count}</TableCell>
                    <TableCell>{formatPercent(row.avg, 1)}</TableCell>
                    <TableCell className="text-slate-400">
                      {row.min.toFixed(1)}–{row.max.toFixed(1)}%
                    </TableCell>
                    <TableCell className="text-slate-400">
                      {formatDate(row.last_sample_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <Card className="p-4 text-xs text-slate-500">
          No legacy history for this patient — the record was created in this
          application.
        </Card>
      )}
    </div>
  );
}
