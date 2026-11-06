import * as React from "react";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Measure the container so charts fill their width without letterboxing. */
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

const GRID = "rgba(148, 163, 184, 0.15)";
const AXIS_TEXT = "#64748b";

function Empty({ message, height = 120 }: { message: string; height?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-card border border-slate-800 bg-slate-900/30 text-xs text-slate-500"
      style={{ height }}
    >
      {message}
    </div>
  );
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Round an axis maximum up to a readable value. */
function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

/* ------------------------------------------------------------------ */
/* A. Session progression - one discrete bar per session               */
/* ------------------------------------------------------------------ */

export interface SessionBarPoint {
  /** Ordinal label, e.g. "Session 1". */
  label: string;
  /** ISO completion timestamp, shown beneath the label. */
  at: string;
  form_score: number;
  /** Mean hold duration per repetition in this session, in seconds. */
  avg_hold_seconds: number;
  reps: number;
}

export type SessionMetric = "form_score" | "avg_hold_seconds" | "reps";

export interface SessionMetricChartProps {
  points: SessionBarPoint[];
  metric: SessionMetric;
  height?: number;
}

const METRIC_SPECS: Record<SessionMetric, { label: string; unit: string; fixedMax?: number }> = {
  form_score: { label: "Form score", unit: "%", fixedMax: 100 },
  avg_hold_seconds: { label: "Hold time per rep", unit: "s" },
  reps: { label: "Reps", unit: "" },
};

/**
 * Discrete progression for one metric: a bar per session, never a line.
 *
 * Sessions are separated by days of rest, so a line between them would assert
 * continuity that was never measured.
 */
export function SessionMetricChart({ points, metric, height = 190 }: SessionMetricChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const spec = METRIC_SPECS[metric];

  if (points.length === 0) {
    return <Empty message="No sessions to plot for this pose." />;
  }

  const padding = { top: 16, right: 12, bottom: 30, left: 38 };
  const usable = Math.max(40, width - padding.left - padding.right);
  // Few sessions in a wide card look lost. Cap the plot and centre it so the
  // bars keep a readable size and spacing.
  const plotWidth = Math.min(usable, Math.max(200, points.length * 96));
  const offsetX = padding.left + (usable - plotWidth) / 2;
  const plotHeight = Math.max(20, height - padding.top - padding.bottom);
  const slot = plotWidth / points.length;
  const barWidth = Math.max(6, Math.min(44, slot * 0.55));
  // Below ~56px per session the labels collide, so show every other one.
  const labelStep = slot < 56 ? 2 : 1;

  const values = points.map((point) => point[metric]);
  const axisMax = spec.fixedMax ?? niceMax(Math.max(...values, 0));
  const y = (value: number) =>
    padding.top + plotHeight - (Math.min(Math.max(value, 0), axisMax) / axisMax) * plotHeight;

  return (
    <div ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${spec.label} per session`}
      >
        {[0, axisMax / 2, axisMax].map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left}
              y1={y(tick)}
              x2={width - padding.right}
              y2={y(tick)}
              stroke={GRID}
            />
            <text
              x={padding.left - 6}
              y={y(tick) + 3}
              textAnchor="end"
              fontSize={9}
              fill={AXIS_TEXT}
            >
              {Math.round(tick)}
              {spec.unit}
            </text>
          </g>
        ))}

        {points.map((point, index) => {
          const value = point[metric];
          const x = offsetX + slot * index + (slot - barWidth) / 2;
          const top = y(value);
          const hasValue = value > 0;
          return (
            <g key={`${point.label}-${index}`}>
              {hasValue && (
                <rect
                  x={x}
                  y={top}
                  width={barWidth}
                  height={Math.max(1, padding.top + plotHeight - top)}
                  rx={3}
                  fill="#2dd4bf"
                  opacity={0.85}
                />
              )}
              <text
                x={x + barWidth / 2}
                y={hasValue ? top - 4 : padding.top + plotHeight - 4}
                textAnchor="middle"
                fontSize={9}
                fill={hasValue ? "#94a3b8" : "#475569"}
              >
                {metric === "form_score" ? Math.round(value) : Math.round(value * 10) / 10}
              </text>
              {index % labelStep === 0 && (
                <>
                  <text
                    x={x + barWidth / 2}
                    y={height - 16}
                    textAnchor="middle"
                    fontSize={9}
                    fill={AXIS_TEXT}
                  >
                    {point.label}
                  </text>
                  <text
                    x={x + barWidth / 2}
                    y={height - 5}
                    textAnchor="middle"
                    fontSize={9}
                    fill="#475569"
                  >
                    {formatDay(point.at)}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* /* B. Rep profile — form decay across reps within one session          */
/* ------------------------------------------------------------------ */

export interface RepProfilePoint {
  rep_index: number;
  duration_sec: number;
  form_score: number;
}

export interface RepProfileChartProps {
  reps: RepProfilePoint[];
  rowHeight?: number;
}

/**
 * Rep-by-rep mechanics inside a single session.
 *
 * Two aligned rows share the rep index: form score on top, hold duration
 * below. Aligned rather than overlaid, because seconds and percent are not
 * comparable on one axis.
 */
export function RepProfileChart({ reps, rowHeight = 110 }: RepProfileChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();

  if (reps.length === 0) {
    return <Empty message="This session recorded no repetitions." />;
  }

  const padding = { top: 12, right: 14, bottom: 22, left: 38 };
  const plotWidth = Math.max(40, width - padding.left - padding.right);
  const plotHeight = Math.max(20, rowHeight - padding.top - padding.bottom);
  const slot = plotWidth / reps.length;

  const x = (index: number) =>
    reps.length === 1
      ? padding.left + plotWidth / 2
      : padding.left + (index / (reps.length - 1)) * plotWidth;

  const scoreMax = 100;
  const scoreY = (value: number) =>
    padding.top + plotHeight - (Math.min(Math.max(value, 0), scoreMax) / scoreMax) * plotHeight;

  const holdMax = niceMax(Math.max(...reps.map((rep) => rep.duration_sec), 0));
  const holdY = (value: number) =>
    padding.top + plotHeight - (Math.min(Math.max(value, 0), holdMax) / holdMax) * plotHeight;

  const first = reps[0].form_score;
  const last = reps[reps.length - 1].form_score;
  const delta = last - first;

  return (
    <div className="space-y-4" ref={containerRef}>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-slate-400">
          {reps.length} rep(s) · first {Math.round(first)}% → last {Math.round(last)}%
        </span>
        <span
          className={
            Math.abs(delta) < 3
              ? "text-slate-500"
              : delta < 0
                ? "text-amber-400"
                : "text-emerald-400"
          }
        >
          {Math.abs(delta) < 3
            ? "stable across the set"
            : delta < 0
              ? `form drops ${Math.round(Math.abs(delta))} points — fatigue pattern`
              : `form rises ${Math.round(delta)} points`}
        </span>
      </div>

      {/* Form score across reps */}
      <div>
        <div className="mb-1 flex items-baseline justify-between text-xs">
          <span className="font-medium text-slate-400">Form score</span>
          <span className="text-slate-600">max 100%</span>
        </div>
        <svg
          viewBox={`0 0 ${width} ${rowHeight}`}
          width="100%"
          height={rowHeight}
          role="img"
          aria-label="Form score per repetition"
        >
          {[0, 50, 100].map((tick) => (
            <g key={tick}>
              <line
                x1={padding.left}
                y1={scoreY(tick)}
                x2={width - padding.right}
                y2={scoreY(tick)}
                stroke={GRID}
              />
              <text
                x={padding.left - 6}
                y={scoreY(tick) + 3}
                textAnchor="end"
                fontSize={9}
                fill={AXIS_TEXT}
              >
                {tick}%
              </text>
            </g>
          ))}

          {reps.length > 1 && (
            <polyline
              fill="none"
              stroke="#2dd4bf"
              strokeWidth={2}
              strokeLinejoin="round"
              points={reps
                .map((rep, index) => `${x(index)},${scoreY(rep.form_score)}`)
                .join(" ")}
            />
          )}
          {reps.map((rep, index) => (
            <circle
              key={`score-${index}`}
              cx={x(index)}
              cy={scoreY(rep.form_score)}
              r={3.5}
              fill="#2dd4bf"
              stroke="#0f172a"
              strokeWidth={1.5}
            />
          ))}
        </svg>
      </div>

      {/* Hold duration across reps */}
      <div>
        <div className="mb-1 flex items-baseline justify-between text-xs">
          <span className="font-medium text-slate-400">Hold duration</span>
          <span className="text-slate-600">max {holdMax}s</span>
        </div>
        <svg
          viewBox={`0 0 ${width} ${rowHeight}`}
          width="100%"
          height={rowHeight}
          role="img"
          aria-label="Hold duration per repetition"
        >
          {[0, holdMax / 2, holdMax].map((tick) => (
            <g key={tick}>
              <line
                x1={padding.left}
                y1={holdY(tick)}
                x2={width - padding.right}
                y2={holdY(tick)}
                stroke={GRID}
              />
              <text
                x={padding.left - 6}
                y={holdY(tick) + 3}
                textAnchor="end"
                fontSize={9}
                fill={AXIS_TEXT}
              >
                {Math.round(tick * 10) / 10}s
              </text>
            </g>
          ))}

          {reps.map((rep, index) => {
            const barWidth = Math.max(6, Math.min(30, slot * 0.55));
            const top = holdY(rep.duration_sec);
            return (
              <g key={`hold-${index}`}>
                <rect
                  x={x(index) - barWidth / 2}
                  y={top}
                  width={barWidth}
                  height={Math.max(1, padding.top + plotHeight - top)}
                  rx={3}
                  fill="#60a5fa"
                  opacity={0.8}
                />
                <text
                  x={x(index)}
                  y={top - 3}
                  textAnchor="middle"
                  fontSize={9}
                  fill="#94a3b8"
                >
                  {rep.duration_sec.toFixed(1)}
                </text>
              </g>
            );
          })}

          {reps.map((rep, index) => (
            <text
              key={`rep-label-${index}`}
              x={x(index)}
              y={rowHeight - 6}
              textAnchor="middle"
              fontSize={9}
              fill={AXIS_TEXT}
            >
              Rep {rep.rep_index}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* C. Hold vs quality — does holding longer cost form?                 */
/* ------------------------------------------------------------------ */

export interface HoldQualityPoint {
  hold: number;
  score: number;
  sessionLabel: string;
}

export interface HoldQualityScatterProps {
  points: HoldQualityPoint[];
  height?: number;
}

/**
 * Scatter of every repetition: hold duration against form score.
 *
 * A downward slope means longer holds degrade quality — a treatment signal
 * that no session average can express.
 */
export function HoldQualityScatter({ points, height = 260 }: HoldQualityScatterProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();

  if (points.length === 0) {
    return <Empty message="No repetitions recorded for this pose yet." />;
  }

  const padding = { top: 12, right: 14, bottom: 30, left: 40 };
  const plotWidth = Math.max(40, width - padding.left - padding.right);
  const plotHeight = Math.max(20, height - padding.top - padding.bottom);

  const holdMax = niceMax(Math.max(...points.map((point) => point.hold), 0));
  const x = (hold: number) =>
    padding.left + (Math.min(Math.max(hold, 0), holdMax) / holdMax) * plotWidth;
  const y = (score: number) =>
    padding.top + plotHeight - (Math.min(Math.max(score, 0), 100) / 100) * plotHeight;

  // Least-squares slope, used only to describe direction, never to predict.
  const meanX = points.reduce((sum, point) => sum + point.hold, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.score, 0) / points.length;
  const covariance = points.reduce(
    (sum, point) => sum + (point.hold - meanX) * (point.score - meanY),
    0,
  );
  const variance = points.reduce((sum, point) => sum + (point.hold - meanX) ** 2, 0);
  const slope = variance > 0 ? covariance / variance : 0;

  const trend =
    points.length < 3
      ? "not enough reps to judge a trend"
      : Math.abs(slope) < 2
        ? "quality holds steady as duration grows"
        : slope < 0
          ? "longer holds cost form — shorten duration first"
          : "form improves with longer holds";

  return (
    <div className="space-y-2" ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Hold duration against form score for each repetition"
      >
        {[0, 50, 100].map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left}
              y1={y(tick)}
              x2={width - padding.right}
              y2={y(tick)}
              stroke={GRID}
            />
            <text
              x={padding.left - 6}
              y={y(tick) + 3}
              textAnchor="end"
              fontSize={9}
              fill={AXIS_TEXT}
            >
              {tick}%
            </text>
          </g>
        ))}

        {[0, holdMax / 2, holdMax].map((tick) => (
          <text
            key={`x-${tick}`}
            x={x(tick)}
            y={height - 14}
            textAnchor="middle"
            fontSize={9}
            fill={AXIS_TEXT}
          >
            {Math.round(tick * 10) / 10}s
          </text>
        ))}

        {points.map((point, index) => (
          <circle
            key={index}
            cx={x(point.hold)}
            cy={y(point.score)}
            r={4}
            fill="#2dd4bf"
            fillOpacity={0.75}
            stroke="#0f172a"
            strokeWidth={1}
          />
        ))}
      </svg>

      <p className="text-center text-xs text-slate-500">
        {points.length} rep(s) · {trend}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* D. Consistency — spread of rep scores within each session           */
/* ------------------------------------------------------------------ */

export interface ConsistencyPoint {
  label: string;
  at: string;
  min: number;
  max: number;
  mean: number;
  count: number;
}

export interface ConsistencyChartProps {
  points: ConsistencyPoint[];
  height?: number;
}

/**
 * Range bar per session: the spread of rep scores behind the mean.
 *
 * Two patients with the same average are clinically different if one is
 * consistent and the other swings wildly; the mean alone hides that.
 */
export function ConsistencyChart({ points, height = 240 }: ConsistencyChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();

  if (points.length === 0) {
    return <Empty message="No sessions to compare." />;
  }

  const padding = { top: 12, right: 16, bottom: 34, left: 40 };
  const usable = Math.max(40, width - padding.left - padding.right);
  // Match the bar charts: cap and centre so few sessions do not look lost.
  const plotWidth = Math.min(usable, Math.max(200, points.length * 96));
  const offsetX = padding.left + (usable - plotWidth) / 2;
  const plotHeight = Math.max(20, height - padding.top - padding.bottom);
  const slot = plotWidth / points.length;

  const x = (index: number) =>
    points.length === 1 ? offsetX + plotWidth / 2 : offsetX + slot * index + slot / 2;
  const y = (score: number) =>
    padding.top + plotHeight - (Math.min(Math.max(score, 0), 100) / 100) * plotHeight;

  const averageSpread =
    points.reduce((sum, point) => sum + (point.max - point.min), 0) / points.length;

  return (
    <div className="space-y-2" ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Spread of repetition scores per session"
      >
        {[0, 50, 100].map((tick) => (
          <g key={tick}>
            <line
              x1={offsetX}
              y1={y(tick)}
              x2={offsetX + plotWidth}
              y2={y(tick)}
              stroke={GRID}
            />
            <text
              x={offsetX - 6}
              y={y(tick) + 3}
              textAnchor="end"
              fontSize={9}
              fill={AXIS_TEXT}
            >
              {tick}%
            </text>
          </g>
        ))}

        {points.map((point, index) => {
          const cx = x(index);
          return (
            <g key={`${point.label}-${index}`}>
              <line
                x1={cx}
                y1={y(point.min)}
                x2={cx}
                y2={y(point.max)}
                stroke="#2dd4bf"
                strokeWidth={2}
                strokeLinecap="round"
                opacity={0.5}
              />
              <line
                x1={cx - 7}
                y1={y(point.min)}
                x2={cx + 7}
                y2={y(point.min)}
                stroke="#2dd4bf"
                strokeWidth={2}
                opacity={0.5}
              />
              <line
                x1={cx - 7}
                y1={y(point.max)}
                x2={cx + 7}
                y2={y(point.max)}
                stroke="#2dd4bf"
                strokeWidth={2}
                opacity={0.5}
              />
              <circle cx={cx} cy={y(point.mean)} r={4} fill="#2dd4bf" />
              <text
                x={cx}
                y={height - 18}
                textAnchor="middle"
                fontSize={9}
                fill={AXIS_TEXT}
              >
                {point.label}
              </text>
              <text x={cx} y={height - 7} textAnchor="middle" fontSize={9} fill="#475569">
                {formatDay(point.at)}
              </text>
            </g>
          );
        })}
      </svg>

      <p className="text-center text-xs text-slate-500">
        average spread {averageSpread.toFixed(1)} points · lower is more consistent
      </p>
    </div>
  );
}
