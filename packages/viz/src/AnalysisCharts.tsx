import * as React from "react";

/* Shared helpers (kept local so the patient charts stay untouched). */

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

/** Round an axis maximum up to a readable value. */
function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

function Empty({ message, height = 120 }: { message: string; height?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-card border border-slate-800 bg-slate-900/30 px-4 text-center text-xs text-slate-500"
      style={{ height }}
    >
      {message}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* A. Pose difficulty — spread of session scores per exercise          */
/* ------------------------------------------------------------------ */

export interface PoseDifficultyRow {
  poseId: string;
  label: string;
  min: number;
  max: number;
  mean: number;
  sessions: number;
}

export interface PoseDifficultyChartProps {
  rows: PoseDifficultyRow[];
  /** Row height in pixels; larger values suit the full-page view. */
  rowHeight?: number;
}

/**
 * Horizontal range bar per pose: how low and how high that exercise scores.
 *
 * A range rather than a single average, because a pose that is uniformly hard
 * and one that is hard only for some patients need different coaching.
 */
export function PoseDifficultyChart({ rows, rowHeight = 30 }: PoseDifficultyChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();

  if (rows.length === 0) {
    return <Empty message="No sessions match these filters." />;
  }

  const labelWidth = 150;
  const padding = { top: 10, right: 16, bottom: 24, left: labelWidth };
  const height = padding.top + padding.bottom + rows.length * rowHeight;
  const plotWidth = Math.max(40, width - padding.left - padding.right);

  const x = (score: number) =>
    padding.left + (Math.min(Math.max(score, 0), 100) / 100) * plotWidth;

  return (
    <div ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Score range per pose"
      >
        {[0, 25, 50, 75, 100].map((tick) => (
          <g key={tick}>
            <line
              x1={x(tick)}
              y1={padding.top}
              x2={x(tick)}
              y2={height - padding.bottom}
              stroke={GRID}
            />
            <text
              x={x(tick)}
              y={height - 8}
              textAnchor="middle"
              fontSize={9}
              fill={AXIS_TEXT}
            >
              {tick}%
            </text>
          </g>
        ))}

        {rows.map((row, index) => {
          const cy = padding.top + index * rowHeight + rowHeight / 2;
          return (
            <g key={row.poseId}>
              <text
                x={labelWidth - 10}
                y={cy + 3}
                textAnchor="end"
                fontSize={10}
                fill="#94a3b8"
              >
                {row.label}
              </text>
              <line
                x1={x(row.min)}
                y1={cy}
                x2={x(row.max)}
                y2={cy}
                stroke="#2dd4bf"
                strokeWidth={3}
                strokeLinecap="round"
                opacity={0.45}
              />
              <circle cx={x(row.mean)} cy={cy} r={5} fill="#2dd4bf" />
              <text x={width - padding.right} y={cy + 3} textAnchor="end" fontSize={9} fill="#475569">
                {row.sessions} session(s)
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* B. Improvement ranking — first vs last session, sorted              */
/* ------------------------------------------------------------------ */

export interface ImprovementRow {
  patientId: string;
  name: string;
  delta: number;
  first: number;
  last: number;
  sessions: number;
}

export interface ImprovementRankingChartProps {
  rows: ImprovementRow[];
  rowHeight?: number;
}

/**
 * Diverging bars around zero: change between a patient's first and most
 * recent session. Sorted so the largest gains and regressions surface first.
 */
export function ImprovementRankingChart({ rows, rowHeight = 26 }: ImprovementRankingChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();

  if (rows.length === 0) {
    return (
      <Empty message="Needs at least two sessions for one patient to compare." />
    );
  }

  const labelWidth = 150;
  const padding = { top: 10, right: 16, bottom: 24, left: labelWidth };
  const height = padding.top + padding.bottom + rows.length * rowHeight;
  const plotWidth = Math.max(40, width - padding.left - padding.right);

  const extent = Math.max(10, ...rows.map((row) => Math.abs(row.delta)));
  const zero = padding.left + plotWidth / 2;
  const scale = (plotWidth / 2) / extent;

  return (
    <div ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Change in form score between first and latest session"
      >
        <line
          x1={zero}
          y1={padding.top}
          x2={zero}
          y2={height - padding.bottom}
          stroke="rgba(148, 163, 184, 0.35)"
        />
        <text x={zero} y={height - 8} textAnchor="middle" fontSize={9} fill={AXIS_TEXT}>
          0
        </text>

        {rows.map((row, index) => {
          const cy = padding.top + index * rowHeight + rowHeight / 2;
          const barLength = Math.abs(row.delta) * scale;
          const positive = row.delta >= 0;
          const barX = positive ? zero : zero - barLength;
          return (
            <g key={row.patientId}>
              <text
                x={labelWidth - 10}
                y={cy + 3}
                textAnchor="end"
                fontSize={10}
                fill="#94a3b8"
              >
                {row.name.length > 18 ? `${row.name.slice(0, 17)}…` : row.name}
              </text>
              <rect
                x={barX}
                y={cy - 7}
                width={Math.max(2, barLength)}
                height={14}
                rx={3}
                fill={positive ? "#22c55e" : "#f59e0b"}
                opacity={0.8}
              />
              <text
                x={positive ? barX + barLength + 6 : barX - 6}
                y={cy + 3}
                textAnchor={positive ? "start" : "end"}
                fontSize={9}
                fill="#94a3b8"
              >
                {row.delta > 0 ? "+" : ""}
                {row.delta.toFixed(0)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* C. BMI vs performance — individual dots plus band means             */
/* ------------------------------------------------------------------ */

export interface BmiPoint {
  bmi: number;
  score: number;
  name: string;
}

export interface BmiBandSummary {
  label: string;
  min: number;
  max: number;
  mean: number;
  count: number;
}

export interface BmiScoreChartProps {
  points: BmiPoint[];
  bands: BmiBandSummary[];
  height?: number;
}

/**
 * Body-mass index against mean form score.
 *
 * Individual patients are small dots; the band averages are larger markers on
 * the same axes. Both encode the same two units, so this is not a dual axis —
 * it is the same scatter with its aggregate made explicit.
 */
export function BmiScoreChart({ points, bands, height = 280 }: BmiScoreChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();

  if (points.length === 0) {
    return (
      <Empty message="No patients have both a usable BMI and a recorded session." />
    );
  }

  const padding = { top: 14, right: 16, bottom: 34, left: 40 };
  const plotWidth = Math.max(40, width - padding.left - padding.right);
  const plotHeight = Math.max(20, height - padding.top - padding.bottom);

  const bmiValues = [...points.map((point) => point.bmi), ...bands.map((band) => band.mean)];
  const bmiMin = Math.max(10, Math.floor(Math.min(...bmiValues) - 2));
  const bmiMax = Math.ceil(Math.max(...bmiValues) + 2);

  const x = (bmi: number) =>
    padding.left + ((bmi - bmiMin) / Math.max(1, bmiMax - bmiMin)) * plotWidth;
  const y = (score: number) =>
    padding.top + plotHeight - (Math.min(Math.max(score, 0), 100) / 100) * plotHeight;

  return (
    <div className="w-full min-w-0 space-y-2 overflow-x-auto" ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Body mass index against mean form score"
      >
        {[0, 25, 50, 75, 100].map((tick) => (
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

        {[bmiMin, Math.round((bmiMin + bmiMax) / 2), bmiMax].map((tick) => (
          <text
            key={`bmi-${tick}`}
            x={x(tick)}
            y={height - 16}
            textAnchor="middle"
            fontSize={9}
            fill={AXIS_TEXT}
          >
            {tick}
          </text>
        ))}
        <text
          x={padding.left + plotWidth / 2}
          y={height - 4}
          textAnchor="middle"
          fontSize={9}
          fill="#475569"
        >
          BMI
        </text>

        {points.map((point, index) => (
          <circle
            key={`${point.name}-${index}`}
            cx={x(point.bmi)}
            cy={y(point.score)}
            r={3.5}
            fill="#60a5fa"
            fillOpacity={0.7}
            stroke="#0f172a"
            strokeWidth={1}
          />
        ))}

        {bands.map((band) => (
          <g key={band.label}>
            <circle
              cx={x(band.mean)}
              cy={y(band.mean === 0 ? 0 : band.mean)}
              r={6}
              fill="none"
              stroke="#2dd4bf"
              strokeWidth={2}
            />
          </g>
        ))}
      </svg>

      <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-[#60a5fa]" />
          patient
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-[#2dd4bf]" />
          band average
        </span>
        {bands
          .filter((band) => band.count > 0)
          .map((band) => (
            <span key={band.label} className="text-slate-500">
              {band.label}: {band.mean.toFixed(0)}% ({band.count})
            </span>
          ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* E. Saved-segment comparison — named cohorts side by side            */
/* ------------------------------------------------------------------ */

export interface SegmentBar {
  id: string;
  label: string;
  value: number;
  patients: number;
  sessions: number;
  color: string;
  /** Overrides the default `Np · Ms` caption beneath the bar. */
  note?: string;
}

export interface SegmentComparisonChartProps {
  bars: SegmentBar[];
  unit: string;
  /** Fixed upper bound (percentages); otherwise derived from the data. */
  fixedMax?: number;
  height?: number;
  emptyMessage?: string;
}

/**
 * One bar per named segment, so the clinician's own cohorts are directly
 * comparable.
 *
 * Bars rather than lines: segments are categories, not points in time.
 */
export function SegmentComparisonChart({
  bars,
  unit,
  fixedMax,
  height = 220,
  emptyMessage = "Add a segment to compare cohorts.",
}: SegmentComparisonChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();

  const visible = bars.filter((bar) => bar.patients > 0);
  if (visible.length === 0) {
    return <Empty message={emptyMessage} />;
  }

  const padding = { top: 18, right: 14, bottom: 42, left: 40 };
  const plotWidth = Math.max(40, width - padding.left - padding.right);
  const plotHeight = Math.max(20, height - padding.top - padding.bottom);
  const slot = plotWidth / visible.length;
  const barWidth = Math.max(18, Math.min(70, slot * 0.55));

  const dataMax = Math.max(...visible.map((bar) => bar.value), 0);
  const axisMax = fixedMax ?? niceMax(dataMax);
  const y = (value: number) =>
    padding.top + plotHeight - (Math.min(Math.max(value, 0), axisMax) / axisMax) * plotHeight;

  return (
    <div ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Comparison of saved segments"
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
              {Math.round(tick * 10) / 10}
              {unit}
            </text>
          </g>
        ))}

        {visible.map((bar, index) => {
          const cx = padding.left + slot * index + slot / 2;
          const top = y(bar.value);
          return (
            <g key={bar.id}>
              <rect
                x={cx - barWidth / 2}
                y={top}
                width={barWidth}
                height={Math.max(1, padding.top + plotHeight - top)}
                rx={4}
                fill={bar.color}
                opacity={0.85}
              />
              <text
                x={cx}
                y={top - 5}
                textAnchor="middle"
                fontSize={10}
                fill="#cbd5e1"
              >
                {Math.round(bar.value * 10) / 10}
                {unit}
              </text>
              <text
                x={cx}
                y={height - 24}
                textAnchor="middle"
                fontSize={9}
                fill="#94a3b8"
              >
                {bar.label.length > 14 ? `${bar.label.slice(0, 13)}…` : bar.label}
              </text>
              <text
                x={cx}
                y={height - 12}
                textAnchor="middle"
                fontSize={8}
                fill="#475569"
              >
                {bar.note ?? `${bar.patients}p · ${bar.sessions}s`}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* D. Adherence — sessions per patient and the gaps between them       */
/* ------------------------------------------------------------------ */

export interface AdherenceRow {
  patientId: string;
  name: string;
  sessions: number;
  medianGapDays: number | null;
}

export interface AdherenceChartProps {
  rows: AdherenceRow[];
  rowHeight?: number;
}

/** Bars of session counts, annotated with the median gap in days. */
export function AdherenceChart({ rows, rowHeight = 26 }: AdherenceChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();

  if (rows.length === 0) {
    return <Empty message="No sessions match these filters." />;
  }

  const labelWidth = 150;
  const padding = { top: 10, right: 60, bottom: 24, left: labelWidth };
  const height = padding.top + padding.bottom + rows.length * rowHeight;
  const plotWidth = Math.max(40, width - padding.left - padding.right);

  const maxSessions = Math.max(1, ...rows.map((row) => row.sessions));
  const barWidth = (sessions: number) => (sessions / maxSessions) * plotWidth;

  return (
    <div ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Sessions recorded per patient"
      >
        <line
          x1={padding.left}
          y1={padding.top}
          x2={padding.left}
          y2={height - padding.bottom}
          stroke="rgba(148, 163, 184, 0.35)"
        />

        {rows.map((row, index) => {
          const cy = padding.top + index * rowHeight + rowHeight / 2;
          return (
            <g key={row.patientId}>
              <text
                x={labelWidth - 10}
                y={cy + 3}
                textAnchor="end"
                fontSize={10}
                fill="#94a3b8"
              >
                {row.name.length > 18 ? `${row.name.slice(0, 17)}…` : row.name}
              </text>
              <rect
                x={padding.left}
                y={cy - 7}
                width={Math.max(2, barWidth(row.sessions))}
                height={14}
                rx={3}
                fill="#a78bfa"
                opacity={0.8}
              />
              <text
                x={width - padding.right + 6}
                y={cy + 3}
                fontSize={9}
                fill="#64748b"
              >
                {row.sessions}
                {row.medianGapDays !== null ? ` · ~${Math.round(row.medianGapDays)}d` : ""}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="mt-1 text-center text-xs text-slate-500">
        bars are session counts · the second figure is the median gap between sessions
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* F. Activity heatmap - engagement at a glance                        */
/* ------------------------------------------------------------------ */

export interface ActivityDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  count: number;
}

export interface ActivityHeatmapProps {
  days: ActivityDay[];
  /** How many weeks to show, ending today. */
  weeks?: number;
  /** Upper bound for the square size, so cells never become enormous. */
  maxCellSize?: number;
  emptyMessage?: string;
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const HEAT_SCALE = ["#1e293b", "#134e4a", "#0f766e", "#14b8a6", "#5eead4"];

/**
 * Calendar heatmap of sessions per day.
 *
 * Answers the engagement question a per-patient bar chart cannot: are sessions
 * spread across the weeks, or clustered into a few bursts? Month labels, weekday
 * labels and a hover readout keep the grid readable rather than abstract.
 */
export function ActivityHeatmap({
  days,
  weeks = 16,
  maxCellSize = 30,
  emptyMessage = "No sessions recorded yet.",
}: ActivityHeatmapProps) {
  const [containerRef, measured] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = React.useState<{
    x: number;
    y: number;
    label: string;
  } | null>(null);

  const total = days.reduce((sum, day) => sum + day.count, 0);
  if (total === 0) {
    return <Empty message={emptyMessage} height={120} />;
  }

  const counts = new Map(days.map((day) => [day.date, day.count]));

  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const gap = 3;
  const gutterLeft = 30;
  const gutterTop = 18;

  // Show as much history as the card can hold rather than a fixed 16 weeks,
  // which left a wide card mostly empty. `weeks` is the minimum.
  const available = Math.max(120, measured - gutterLeft);
  const shownWeeks = Math.min(
    52,
    Math.max(weeks, Math.floor((available + gap) / 34)),
  );

  const start = new Date(end);
  start.setDate(start.getDate() - (shownWeeks * 7 - 1));
  // Align the first column to Monday so rows read as weekdays.
  const cells: Array<{ col: number; row: number; date: string; count: number }> = [];

  const cursor = new Date(start);
  let index = 0;
  while (cursor <= end) {
    const key = localDayKey(cursor);
    cells.push({
      col: Math.floor(index / 7),
      row: index % 7,
      date: key,
      count: counts.get(key) ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
    index += 1;
  }

  const columns = Math.ceil(cells.length / 7);
  const max = Math.max(1, ...cells.map((cell) => cell.count));

  // Size the squares from the available width so they stay square and the
  // grid fills its card instead of being scaled up by the SVG viewBox.
  const cellSize = Math.max(
    8,
    Math.min(maxCellSize, Math.floor((available - (columns - 1) * gap) / columns)),
  );

  const width = gutterLeft + columns * (cellSize + gap);
  const height = gutterTop + 7 * (cellSize + gap) + 4;

  const shade = (count: number) => {
    if (count <= 0) return HEAT_SCALE[0];
    const step = Math.ceil((count / max) * (HEAT_SCALE.length - 1));
    return HEAT_SCALE[Math.min(HEAT_SCALE.length - 1, Math.max(1, step))];
  };

  // Month labels sit above the first column that starts a new month.
  const monthLabels: Array<{ col: number; label: string }> = [];
  let lastMonth = -1;
  for (let col = 0; col < columns; col += 1) {
    const monday = new Date(start);
    monday.setDate(monday.getDate() + col * 7);
    if (monday.getMonth() !== lastMonth) {
      lastMonth = monday.getMonth();
      monthLabels.push({
        col,
        label: monday.toLocaleDateString("en-GB", { month: "short" }),
      });
    }
  }

  const weekdayLabels = [
    { row: 0, label: "Mon" },
    { row: 2, label: "Wed" },
    { row: 4, label: "Fri" },
  ];

  return (
    <div className="space-y-2" ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="mx-auto block max-w-full"
        role="img"
        aria-label={`${total} session(s) over the last ${weeks} weeks`}
        onMouseLeave={() => setHover(null)}
      >
        {monthLabels.map((entry) => (
          <text
            key={`m-${entry.col}`}
            x={gutterLeft + entry.col * (cellSize + gap)}
            y={11}
            fontSize={9}
            fill="#94a3b8"
          >
            {entry.label}
          </text>
        ))}

        {weekdayLabels.map((entry) => (
          <text
            key={`d-${entry.row}`}
            x={0}
            y={gutterTop + entry.row * (cellSize + gap) + cellSize - 3}
            fontSize={9}
            fill="#64748b"
          >
            {entry.label}
          </text>
        ))}

        {cells.map((cell) => {
          const x = gutterLeft + cell.col * (cellSize + gap);
          const y = gutterTop + cell.row * (cellSize + gap);
          return (
            <rect
              key={cell.date}
              x={x}
              y={y}
              width={cellSize}
              height={cellSize}
              rx={2.5}
              fill={shade(cell.count)}
              stroke="transparent"
              onMouseEnter={() =>
                setHover({
                  x: x + cellSize / 2,
                  y,
                  label: `${new Date(cell.date).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })} — ${cell.count} session(s)`,
                })
              }
            />
          );
        })}

        {hover && (
          <g pointerEvents="none">
            <rect
              x={Math.min(Math.max(hover.x - 62, 0), width - 124)}
              y={Math.max(0, hover.y - 24)}
              width={124}
              height={18}
              rx={4}
              fill="#0f172a"
              stroke="#334155"
            />
            <text
              x={Math.min(Math.max(hover.x - 62, 0), width - 124) + 62}
              y={Math.max(0, hover.y - 24) + 12}
              textAnchor="middle"
              fontSize={9}
              fill="#e2e8f0"
            >
              {hover.label}
            </text>
          </g>
        )}
      </svg>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500">
        <span>
          {total} session(s) in the last {weeks} weeks
        </span>
        <span className="inline-flex items-center gap-1">
          less
          {HEAT_SCALE.map((colour) => (
            <span
              key={colour}
              className="inline-block rounded-[2px]"
              style={{ backgroundColor: colour, width: 10, height: 10 }}
            />
          ))}
          more
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* G. Cohort histogram — where each cohort's repetitions cluster       */
/* ------------------------------------------------------------------ */

export interface HistogramSeries {
  id: string;
  label: string;
  color: string;
  /** Every repetition's form score for this series, 0-100. */
  scores: number[];
}

export interface CohortHistogramProps {
  series: HistogramSeries[];
  height?: number;
  emptyMessage?: string;
}

const HISTOGRAM_BINS = 10;

/**
 * Distribution of repetition scores per cohort, grouped within each bucket.
 *
 * Grouped rather than stacked: stacking would make only the bottom segment
 * share a baseline, so cohorts could not be compared by height. One colour per
 * cohort matches the comparison bars above.
 */
export function CohortHistogram({
  series,
  height = 240,
  emptyMessage = "No repetition scores recorded yet.",
}: CohortHistogramProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();

  const usable = series
    .map((entry) => ({
      ...entry,
      values: entry.scores.filter((score) => Number.isFinite(score) && score >= 0),
    }))
    .filter((entry) => entry.values.length > 0);

  if (usable.length === 0) {
    return <Empty message={emptyMessage} />;
  }

  const buckets = usable.map((entry) => {
    const counts = new Array(HISTOGRAM_BINS).fill(0) as number[];
    for (const score of entry.values) {
      const index = Math.min(
        HISTOGRAM_BINS - 1,
        Math.max(0, Math.floor((score / 100) * HISTOGRAM_BINS)),
      );
      counts[index] += 1;
    }
    return { ...entry, counts };
  });

  const padding = { top: 14, right: 12, bottom: 34, left: 34 };
  const plotWidth = Math.max(40, width - padding.left - padding.right);
  const plotHeight = Math.max(20, height - padding.top - padding.bottom);
  const slot = plotWidth / HISTOGRAM_BINS;
  const groupWidth = slot * 0.78;
  const barWidth = Math.max(2, groupWidth / buckets.length);
  const maxCount = Math.max(1, ...buckets.flatMap((entry) => entry.counts));
  const y = (count: number) =>
    padding.top + plotHeight - (count / maxCount) * plotHeight;

  return (
    <div className="space-y-2" ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Distribution of repetition form scores per cohort"
      >
        {[0, Math.round(maxCount / 2), maxCount].map((tick) => (
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
              {tick}
            </text>
          </g>
        ))}

        {Array.from({ length: HISTOGRAM_BINS }, (_, bucketIndex) => {
          const groupX = padding.left + slot * bucketIndex + (slot - groupWidth) / 2;
          return (
            <g key={bucketIndex}>
              {buckets.map((entry, seriesIndex) => {
                const count = entry.counts[bucketIndex];
                const top = y(count);
                const x = groupX + barWidth * seriesIndex;
                return (
                  <rect
                    key={entry.id}
                    x={x}
                    y={top}
                    width={Math.max(1, barWidth - 1)}
                    height={Math.max(count > 0 ? 2 : 0, padding.top + plotHeight - top)}
                    rx={2}
                    fill={entry.color}
                    opacity={0.9}
                  />
                );
              })}
              <text
                x={groupX + groupWidth / 2}
                y={height - 14}
                textAnchor="middle"
                fontSize={9}
                fill={AXIS_TEXT}
              >
                {bucketIndex * 10}
              </text>
            </g>
          );
        })}

        <text
          x={padding.left + plotWidth / 2}
          y={height - 2}
          textAnchor="middle"
          fontSize={9}
          fill="#475569"
        >
          form score (%)
        </text>
      </svg>

      <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-slate-400">
        {buckets.map((entry) => (
          <span key={entry.id} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            {entry.label}
            <span className="text-slate-600">({entry.values.length} reps)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* H. Cohort strip plot — every point behind the mean                  */
/* ------------------------------------------------------------------ */

export interface StripSeries {
  id: string;
  label: string;
  color: string;
  /** One value per observation, e.g. one repetition. */
  values: number[];
}

export interface CohortStripPlotProps {
  series: StripSeries[];
  unit: string;
  fixedMax?: number;
  height?: number;
  emptyMessage?: string;
}

/**
 * Every observation as a dot, with the mean marked.
 *
 * A bar shows only the average, which hides whether a cohort is consistent or
 * wildly variable. The dots are the data the average was computed from, and the
 * dashed line keeps the summary available.
 */
export function CohortStripPlot({
  series,
  unit,
  fixedMax,
  height = 240,
  emptyMessage = "No data to plot.",
}: CohortStripPlotProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();

  const usable = series.filter((entry) => entry.values.length > 0);
  if (usable.length === 0) {
    return <Empty message={emptyMessage} />;
  }

  const padding = { top: 14, right: 12, bottom: 42, left: 40 };
  const plotWidth = Math.max(40, width - padding.left - padding.right);
  const plotHeight = Math.max(20, height - padding.top - padding.bottom);
  const slot = plotWidth / usable.length;

  const allValues = usable.flatMap((entry) => entry.values);
  const axisMax = fixedMax ?? niceMax(Math.max(...allValues, 0));
  const y = (value: number) =>
    padding.top + plotHeight - (Math.min(Math.max(value, 0), axisMax) / axisMax) * plotHeight;

  /** Even horizontal spread so overlapping points stay countable. */
  const offset = (index: number) => ((index % 9) - 4) / 4;

  return (
    <div ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Individual observations per cohort"
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
              {Math.round(tick * 10) / 10}
              {unit}
            </text>
          </g>
        ))}

        {usable.map((entry, seriesIndex) => {
          const cx = padding.left + slot * seriesIndex + slot / 2;
          const spread = Math.min(46, slot * 0.34);
          const mean =
            entry.values.reduce((total, value) => total + value, 0) /
            entry.values.length;

          return (
            <g key={entry.id}>
              {entry.values.map((value, index) => (
                <circle
                  key={index}
                  cx={cx + offset(index) * spread}
                  cy={y(value)}
                  r={3}
                  fill={entry.color}
                  fillOpacity={0.55}
                />
              ))}
              <line
                x1={cx - spread - 4}
                y1={y(mean)}
                x2={cx + spread + 4}
                y2={y(mean)}
                stroke={entry.color}
                strokeWidth={2}
                strokeDasharray="4 3"
              />
              <text
                x={cx}
                y={height - 22}
                textAnchor="middle"
                fontSize={9}
                fill="#94a3b8"
              >
                {entry.label.length > 13 ? `${entry.label.slice(0, 12)}…` : entry.label}
              </text>
              <text
                x={cx}
                y={height - 9}
                textAnchor="middle"
                fontSize={8}
                fill="#475569"
              >
                {entry.values.length} pts · mean {mean.toFixed(1)}
                {unit}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* I. Cohort scatter — two quantities per cohort                       */
/* ------------------------------------------------------------------ */

export interface ScatterPoint {
  id: string;
  label: string;
  color: string;
  x: number;
  y: number;
}

export interface CohortScatterPlotProps {
  points: ScatterPoint[];
  xLabel: string;
  yLabel: string;
  height?: number;
  emptyMessage?: string;
}

/**
 * One dot per cohort plotting two different quantities.
 *
 * Used where two measures have different units and must not share a bar
 * chart's axis — sessions (a count) against reps per session (a ratio).
 */
export function CohortScatterPlot({
  points,
  xLabel,
  yLabel,
  height = 240,
  emptyMessage = "No data to plot.",
}: CohortScatterPlotProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();

  const usable = points.filter(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x > 0,
  );
  if (usable.length === 0) {
    return <Empty message={emptyMessage} />;
  }

  const padding = { top: 16, right: 18, bottom: 38, left: 44 };
  const plotWidth = Math.max(40, width - padding.left - padding.right);
  const plotHeight = Math.max(20, height - padding.top - padding.bottom);

  const xMax = niceMax(Math.max(...usable.map((point) => point.x)));
  const yMax = niceMax(Math.max(...usable.map((point) => point.y)));

  const x = (value: number) =>
    padding.left + (Math.min(Math.max(value, 0), xMax) / xMax) * plotWidth;
  const y = (value: number) =>
    padding.top + plotHeight - (Math.min(Math.max(value, 0), yMax) / yMax) * plotHeight;

  return (
    <div ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`${yLabel} against ${xLabel} per cohort`}
      >
        {[0, yMax / 2, yMax].map((tick) => (
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
              {Math.round(tick * 10) / 10}
            </text>
          </g>
        ))}

        {[0, xMax / 2, xMax].map((tick) => (
          <text
            key={`x-${tick}`}
            x={x(tick)}
            y={height - 18}
            textAnchor="middle"
            fontSize={9}
            fill={AXIS_TEXT}
          >
            {Math.round(tick * 10) / 10}
          </text>
        ))}

        <text
          x={padding.left + plotWidth / 2}
          y={height - 5}
          textAnchor="middle"
          fontSize={9}
          fill="#475569"
        >
          {xLabel}
        </text>
        <text
          x={10}
          y={padding.top + plotHeight / 2}
          textAnchor="middle"
          fontSize={9}
          fill="#475569"
          transform={`rotate(-90 10 ${padding.top + plotHeight / 2})`}
        >
          {yLabel}
        </text>

        {usable.map((point) => (
          <g key={point.id}>
            <circle cx={x(point.x)} cy={y(point.y)} r={7} fill={point.color} fillOpacity={0.85} />
            <text
              x={x(point.x)}
              y={y(point.y) - 12}
              textAnchor="middle"
              fontSize={9}
              fill="#94a3b8"
            >
              {point.label.length > 12 ? `${point.label.slice(0, 11)}…` : point.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
