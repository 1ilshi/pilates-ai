import * as React from "react";

/** One session's measurements for a single pose. */
export interface PoseMetricPoint {
  /** ISO timestamp or epoch milliseconds. */
  at: string | number;
  form_score: number;
  hold_seconds: number;
  reps: number;
}

/** One pose plotted across time. */
export interface PoseMetricSeries {
  id: string;
  label: string;
  color: string;
  points: PoseMetricPoint[];
}

export interface PoseMetricsChartProps {
  series: PoseMetricSeries[];
  /** Height of each metric row, in pixels. */
  rowHeight?: number;
  emptyMessage?: string;
}

/** Stable colour per pose so a pose keeps its identity across views. */
export const POSE_COLORS: Record<string, string> = {
  pose1: "#2dd4bf",
  pose2: "#60a5fa",
  pose3: "#f472b6",
  pose4: "#fbbf24",
  pose5: "#a78bfa",
};

const FALLBACK_COLORS = ["#2dd4bf", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa", "#34d399"];

/** Deterministic colour for a pose id, falling back to a palette by index. */
export function poseColor(poseId: string, index = 0): string {
  return POSE_COLORS[poseId] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

interface MetricSpec {
  key: keyof Omit<PoseMetricPoint, "at">;
  label: string;
  unit: string;
  /** Fixed upper bound (scores are percentages); otherwise derived from data. */
  fixedMax?: number;
}

const METRICS: MetricSpec[] = [
  { key: "form_score", label: "Pose accuracy", unit: "%", fixedMax: 100 },
  { key: "hold_seconds", label: "Hold time", unit: "s" },
  { key: "reps", label: "Reps", unit: "" },
];

function toMillis(at: string | number): number {
  if (typeof at === "number") return at;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDay(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Measure the container so the chart fills its width exactly. */
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T | null>(null);
  const [width, setWidth] = React.useState(640);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = () => {
      const next = element.clientWidth;
      if (next > 0) setWidth(next);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/**
 * Progress chart showing pose accuracy, hold time and repetitions as three
 * stacked series on a shared time axis.
 *
 * Each row scales independently (a percentage, seconds and a count cannot
 * share one axis), and every selected pose overlays in its own colour.
 */
export function PoseMetricsChart({
  series,
  rowHeight = 130,
  emptyMessage = "Select at least one pose to plot.",
}: PoseMetricsChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();

  const plotted = React.useMemo(
    () =>
      series
        .map((entry) => ({
          ...entry,
          points: entry.points
            .map((point) => ({
              at: toMillis(point.at),
              form_score: Number(point.form_score) || 0,
              hold_seconds: Number(point.hold_seconds) || 0,
              reps: Number(point.reps) || 0,
            }))
            .filter((point) => Number.isFinite(point.at) && point.at > 0)
            .sort((a, b) => a.at - b.at),
        }))
        .filter((entry) => entry.points.length > 0),
    [series],
  );

  if (plotted.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-card border border-slate-800 bg-slate-900/30 py-10 text-xs text-slate-500">
        {emptyMessage}
      </div>
    );
  }

  const allPoints = plotted.flatMap((entry) => entry.points);
  const minTime = Math.min(...allPoints.map((point) => point.at));
  const maxTime = Math.max(...allPoints.map((point) => point.at));
  const span = maxTime - minTime;

  const padding = { top: 10, right: 14, bottom: 20, left: 40 };
  const plotWidth = Math.max(40, width - padding.left - padding.right);
  const plotHeight = Math.max(20, rowHeight - padding.top - padding.bottom);

  const x = (at: number) =>
    span === 0
      ? padding.left + plotWidth / 2
      : padding.left + ((at - minTime) / span) * plotWidth;

  const sameDay = formatDay(minTime) === formatDay(maxTime);

  return (
    <div className="space-y-4" ref={containerRef}>
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
        {plotted.map((entry) => (
          <span key={entry.id} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            {entry.label}
            <span className="text-slate-600">({entry.points.length})</span>
          </span>
        ))}
      </div>

      {METRICS.map((metric, metricIndex) => {
        const values = allPoints.map((point) => point[metric.key]);
        const dataMax = Math.max(...values, 0);
        const axisMax = metric.fixedMax ?? Math.max(1, Math.ceil(dataMax));
        const y = (value: number) =>
          padding.top + plotHeight - (Math.min(Math.max(value, 0), axisMax) / axisMax) * plotHeight;
        const ticks = [0, axisMax / 2, axisMax];

        return (
          <div key={metric.key}>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="font-medium text-slate-400">{metric.label}</span>
              <span className="text-slate-600">
                {metric.unit ? `max ${axisMax}${metric.unit}` : `max ${axisMax}`}
              </span>
            </div>

            <svg
              viewBox={`0 0 ${width} ${rowHeight}`}
              width="100%"
              height={rowHeight}
              role="img"
              aria-label={`${metric.label} across ${plotted.length} pose series`}
            >
              {ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={padding.left}
                    y1={y(tick)}
                    x2={width - padding.right}
                    y2={y(tick)}
                    stroke="rgba(148, 163, 184, 0.15)"
                    strokeWidth={1}
                  />
                  <text
                    x={padding.left - 8}
                    y={y(tick) + 3}
                    textAnchor="end"
                    fontSize={10}
                    fill="#64748b"
                  >
                    {Math.round(tick)}
                    {metric.unit}
                  </text>
                </g>
              ))}

              {plotted.map((entry) => {
                const value = (point: (typeof entry.points)[number]) => point[metric.key];
                return (
                  <g key={`${entry.id}-${metric.key}`}>
                    {entry.points.length > 1 && (
                      <polyline
                        fill="none"
                        stroke={entry.color}
                        strokeWidth={2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        points={entry.points
                          .map((point) => `${x(point.at)},${y(value(point))}`)
                          .join(" ")}
                      />
                    )}
                    {entry.points.map((point, index) => (
                      <circle
                        key={`${entry.id}-${metric.key}-${index}`}
                        cx={x(point.at)}
                        cy={y(value(point))}
                        r={3.5}
                        fill={entry.color}
                        stroke="#0f172a"
                        strokeWidth={1.5}
                      />
                    ))}
                  </g>
                );
              })}

              {metricIndex === METRICS.length - 1 && (
                <>
                  <text x={padding.left} y={rowHeight - 6} fontSize={10} fill="#64748b">
                    {formatDay(minTime)}
                    {sameDay && span > 0 ? ` ${formatTime(minTime)}` : ""}
                  </text>
                  {span > 0 && (
                    <text
                      x={width - padding.right}
                      y={rowHeight - 6}
                      fontSize={10}
                      fill="#64748b"
                      textAnchor="end"
                    >
                      {formatDay(maxTime)}
                      {sameDay ? ` ${formatTime(maxTime)}` : ""}
                    </text>
                  )}
                </>
              )}
            </svg>
          </div>
        );
      })}
    </div>
  );
}
