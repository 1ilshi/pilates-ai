import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  CalendarCheck,
  Gauge,
  Users,
} from "lucide-react";
import { ActivityHeatmap, ImprovementRankingChart } from "@pilates/viz";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  formatPercent,
} from "@pilates/ui";
import { buildCohort, improvement, poseOptions } from "../lib/analytics";
import { needsAttention } from "../lib/attention";
import { useClinicData } from "../lib/useClinicData";
import { ChartCard, ChartOverlay, useExpandedChart } from "../components/ChartCard";
import { PoseSelect } from "../components/PoseSelect";

function relativeTime(from: number | null): string {
  if (!from) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - from) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** `15 Oct 2030` — day first, unambiguous across locales. */
function formatDay(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function Hero({
  label,
  value,
  hint,
  icon,
  tint,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  /** Pastel chip classes, e.g. "bg-chart-1/15 text-chart-1". */
  tint: string;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-2 truncate font-mono text-3xl font-semibold tracking-tight text-foreground">{value}</p>
          {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", tint)}>
          {icon}
        </span>
      </div>
    </Card>
  );
}

/**
 * Clinic overview.
 *
 * Headline numbers, the triage list, and two charts that answer "how are we
 * doing and who needs me". Everything comparative and cohort-based lives on
 * the Analysis page.
 */
export function OverviewPage() {
  const { patients, sessions, loading, error, updatedAt } = useClinicData();
  const { expanded, expand, collapse } = useExpandedChart();
  const [improvementPose, setImprovementPose] = useState("");

  const cohort = useMemo(() => buildCohort(patients, sessions), [patients, sessions]);
  const attention = useMemo(() => needsAttention(cohort), [cohort]);
  const poses = useMemo(() => poseOptions(cohort), [cohort]);
  const ranking = useMemo(
    () => improvement(cohort, improvementPose),
    [cohort, improvementPose],
  );

  /** Sessions per local calendar day, for the engagement heatmap. */
  const activityDays = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) {
      if (!session.completed_at) continue;
      const date = new Date(session.completed_at);
      if (Number.isNaN(date.getTime())) continue;
      const key = `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].map(([date, count]) => ({ date, count }));
  }, [sessions]);

  const scored = cohort.filter((row) => row.meanScore > 0);
  const meanScore = scored.length
    ? scored.reduce((total, row) => total + row.meanScore, 0) / scored.length
    : 0;

  const lastActivity =
    sessions
      .map((session) => session.completed_at)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;

  // The full-page view should feel like it, not a slightly wider card.
  const expandedHeight = Math.max(380, Math.round(window.innerHeight * 0.62));

  /** Row height that fills the panel without overflowing it. */
  const fitRows = (count: number) =>
    Math.max(32, Math.min(84, Math.floor(expandedHeight / Math.max(1, count))));

  const chartTitles: Record<string, string> = {
    improvement: "Improvement ranking",
    activity: "Activity",
  };

  const renderChart = (id: string) => {
    switch (id) {
      case "improvement":
        return (
          <ImprovementRankingChart rows={ranking} rowHeight={fitRows(ranking.length)} />
        );
      case "activity":
        return (
          <ActivityHeatmap
            days={activityDays}
            weeks={26}
            maxCellSize={56}
          />
        );
      default:
        return null;
    }
  };

  const chartControls = (id: string) =>
    id === "improvement" ? (
      <PoseSelect
        poses={poses}
        value={improvementPose}
        onChange={setImprovementPose}
        label="Pose for improvement ranking"
      />
    ) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
            Clinic overview
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {patients.length} patient(s) · {sessions.length} session(s) recorded
          </p>
        </div>
        <Badge variant={error ? "warning" : "success"} dot>
          {error ? "Reconnecting" : `Live · ${relativeTime(updatedAt)}`}
        </Badge>
      </div>

      {error && (
        <Card className="min-w-0 overflow-hidden border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-300">
          {/* The Firestore index message embeds a URL with no spaces. Without
              wrapping it stretches the page and every layout after it. */}
          <p className="break-words [overflow-wrap:anywhere]">
            Showing the last successful read. {error}
          </p>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Hero
          label="Patients"
          value={String(patients.length)}
          hint={`${patients.filter((patient) => patient.legacy).length} with legacy history`}
          icon={<Users className="h-5 w-5" aria-hidden="true" />}
          tint="bg-chart-1/15 text-chart-1"
        />
        <Hero
          label="Sessions"
          value={String(sessions.length)}
          hint={`${poses.length} pose(s) in use`}
          icon={<CalendarCheck className="h-5 w-5" aria-hidden="true" />}
          tint="bg-chart-2/15 text-chart-2"
        />
        <Hero
          label="Mean pose accuracy"
          value={meanScore ? formatPercent(meanScore, 1) : "—"}
          hint={`${scored.length} patient(s) scored`}
          icon={<Gauge className="h-5 w-5" aria-hidden="true" />}
          tint="bg-chart-3/15 text-chart-3"
        />
        <Hero
          label="Last activity"
          value={formatDay(lastActivity)}
          hint={lastActivity ? "most recent session" : "no sessions yet"}
          icon={<Activity className="h-5 w-5" aria-hidden="true" />}
          tint="bg-chart-4/15 text-chart-4"
        />
      </div>

      <Card>
        <CardHeader className="pb-0">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden="true" />
            <CardTitle className="text-sm">Needs attention</CardTitle>
            <Badge variant={attention.length > 0 ? "warning" : "secondary"}>
              {attention.length}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Lapsed beyond 21 days, a fall of 10+ points since the previous
            session, or no improvement across three or more sessions.
          </p>
        </CardHeader>
        <CardContent className="pt-3">
          {attention.length === 0 ? (
            <p className="py-3 text-xs text-muted-foreground">
              No patients need attention right now.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {attention.map((item) => (
                <li key={item.patientId} className="flex items-center gap-3 py-2.5">
                  <Badge
                    variant={
                      item.reason === "Lapsed"
                        ? "destructive"
                        : item.reason === "Declining"
                          ? "warning"
                          : "secondary"
                    }
                  >
                    {item.reason}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/patients/${item.patientId}`}
                state={{ from: "Overview" }}
                      className="truncate text-sm font-medium text-primary hover:underline"
                    >
                      {item.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">{item.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <ChartCard
          title="Improvement ranking"
          description="Change between each patient's first and latest session."
          onExpand={() => expand("improvement")}
          action={chartControls("improvement")}
        >
          <ImprovementRankingChart rows={ranking} />
        </ChartCard>

        <ChartCard
          title="Activity"
          description="Sessions per day over the last 16 weeks — engagement spread, not just totals."
          onExpand={() => expand("activity")}
        >
          <ActivityHeatmap days={activityDays} maxCellSize={30} />
        </ChartCard>
      </div>

      {loading && <p className="text-xs text-muted-foreground">Loading clinic data…</p>}

      {expanded && (
        <ChartOverlay
          title={chartTitles[expanded] ?? "Chart"}
          actions={chartControls(expanded)}
          onClose={collapse}
        >
          {renderChart(expanded)}
        </ChartOverlay>
      )}
    </div>
  );
}
