import * as React from "react";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowDownRight, ArrowRight, ArrowUpRight, TrendingUp } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  formatPercent,
} from "@pilates/ui";

export interface SessionTrendPoint {
  session_id: string;
  /** ISO-8601 UTC session completion timestamp. */
  started_at: string;
  mean_form_score: number;
  total_reps: number;
  peak_rom_angle: number;
}

export interface SessionTrendCardProps {
  /** Sessions in chronological order (oldest first). */
  sessions: SessionTrendPoint[];
  title?: string;
  description?: string;
  className?: string;
  height?: number;
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Historical progress card: headline form-score delta versus the previous
 * session, a sparkline of the score trend and the latest rep/ROM figures.
 */
export function SessionTrendCard({
  sessions,
  title = "Session trend",
  description,
  className,
  height = 120,
}: SessionTrendCardProps) {
  const ordered = React.useMemo(
    () =>
      [...sessions].sort(
        (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at),
      ),
    [sessions],
  );

  if (!ordered.length) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>No sessions recorded yet</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const latest = ordered[ordered.length - 1];
  const previous = ordered.length > 1 ? ordered[ordered.length - 2] : undefined;
  const delta = previous ? latest.mean_form_score - previous.mean_form_score : 0;

  const TrendIcon =
    !previous || Math.abs(delta) < 0.05
      ? ArrowRight
      : delta > 0
        ? ArrowUpRight
        : ArrowDownRight;

  const deltaTone =
    !previous || Math.abs(delta) < 0.05
      ? "text-slate-400"
      : delta > 0
        ? "text-emerald-400"
        : "text-red-400";

  const chartData = ordered.map((session) => ({
    label: formatDay(session.started_at),
    score: session.mean_form_score,
  }));

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-brand-400" aria-hidden="true" />
            {title}
          </CardTitle>
          <CardDescription>
            {description ?? `${ordered.length} sessions recorded`}
          </CardDescription>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-slate-100">
            {formatPercent(latest.mean_form_score)}
          </div>
          <div className={cn("flex items-center justify-end gap-1 text-xs font-medium", deltaTone)}>
            <TrendIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {previous ? `${delta > 0 ? "+" : ""}${delta.toFixed(1)} pts` : "first session"}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <XAxis dataKey="label" hide />
              <YAxis domain={[0, 100]} hide />
              <Tooltip
                contentStyle={{
                  background: "#0f172a",
                  border: "1px solid #1e293b",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#94a3b8" }}
                formatter={(value) => [`${Number(value).toFixed(1)}%`, "mean form score"]}
              />
              <Line
                type="monotone"
                dataKey="score"
                stroke="#2dd4bf"
                strokeWidth={2}
                dot={{ r: 2, fill: "#2dd4bf" }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <dl className="grid grid-cols-3 gap-2 border-t border-slate-800 pt-3 text-center">
          <div>
            <dt className="text-xs text-slate-500">Reps</dt>
            <dd className="text-sm font-semibold text-slate-200">{latest.total_reps}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Peak ROM</dt>
            <dd className="text-sm font-semibold text-slate-200">
              {`${latest.peak_rom_angle.toFixed(1)}\u00b0`}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Sessions</dt>
            <dd className="text-sm font-semibold text-slate-200">{ordered.length}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
