import { useEffect, useMemo, useState } from "react";
import { Download, Pencil, Plus, Trash2 } from "lucide-react";
import {
  AdherenceChart,
  BmiScoreChart,
  CohortHistogram,
  CohortRepScatter,
  CohortScatterPlot,
  CohortStripPlot,
  PoseDifficultyChart,
  SegmentComparisonChart,
} from "@pilates/viz";
import { Button, Card } from "@pilates/ui";
import {
  adherence,
  bmiBands,
  bmiPoints,
  buildCohort,
  poseDifficulty,
  poseOptions,
} from "../lib/analytics";
import {
  COHORT_COLORS,
  COHORT_RANGES,
  MAX_COHORTS,
  cohortBars,
  cohortValues,
  emptyCohort,
  enabledCohorts,
  isCohortEmpty,
  loadCohorts,
  matchesCohort,
  saveCohorts,
  type Cohort,
} from "../lib/cohorts";
import { ChartCard, ChartOverlay, useExpandedChart } from "../components/ChartCard";
import { poseDisplayLabel } from "@pilates/types";
import { PoseSelect } from "../components/PoseSelect";
import { Modal } from "../components/Modal";
import { AnalysisExportDialog } from "../components/AnalysisExportDialog";
import { useClinicData } from "../lib/useClinicData";
import type {
  ExportChart,
  ExportChartSeries,
  ExportChartSpec,
  ExportTable,
} from "../lib/analysisExport";

/** Small segmented control used for the chart view switches. */
function Toggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-control border border-border text-[11px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={
            value === option.value
              ? "bg-primary/20 px-2 py-1 font-medium text-primary"
              : "px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function roundTo(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Count, mean and range for one scatter series. */
function summarize(values: number[]) {
  if (values.length === 0) return null;
  let min = values[0];
  let max = values[0];
  let total = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    total += value;
  }
  return {
    count: values.length,
    mean: total / values.length,
    min,
    max,
  };
}

/** Ten-point buckets, matching the histogram chart. */
function histogramCounts(values: number[]): number[] {
  const counts = new Array(10).fill(0) as number[];
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) continue;
    const index = Math.min(9, Math.max(0, Math.floor((value / 100) * 10)));
    counts[index] += 1;
  }
  return counts;
}

/**
 * Clinic-wide analysis.
 *
 * Cohorts are the only patient-selection concept here: they act as the scope
 * filter *and* as the series in the comparison charts, so there is no separate
 * filter panel duplicating the same criteria. With no cohorts defined the page
 * shows the whole clinic.
 */
export function AnalysisPage() {
  const { patients, sessions, loading, error } = useClinicData();
  const [cohorts, setCohorts] = useState<Cohort[]>(() => loadCohorts());
  const { expanded, expand, collapse } = useExpandedChart();
  const [editing, setEditing] = useState<Cohort | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Pose is a separate axis from cohort: it narrows what is measured.
  const [cohortPose, setCohortPose] = useState("");
  const [bmiPose, setBmiPose] = useState("");
  const [adherencePose, setAdherencePose] = useState("");
  const [scoreView, setScoreView] = useState<"mean" | "scatter">("mean");
  const [scoreBasis, setScoreBasis] = useState<"rep" | "session">("rep");
  const [holdView, setHoldView] = useState<"mean" | "scatter">("mean");
  const [sessionsView, setSessionsView] = useState<"count" | "scatter">("count");
  const [exportOpen, setExportOpen] = useState(false);

  // Persist on every change so the setup survives a reload or a restart.
  useEffect(() => {
    saveCohorts(cohorts);
  }, [cohorts]);

  const everyone = useMemo(() => buildCohort(patients, sessions), [patients, sessions]);

  /**
   * Cohorts are comparison-only: they select the bars in the two charts of the
   * cohort section and nothing else. Everything below stays clinic-wide, which
   * is what the section grouping communicates.
   */
  const scoped = everyone;


  const difficulty = useMemo(() => poseDifficulty(scoped), [scoped]);
  const poses = useMemo(() => poseOptions(scoped), [scoped]);
  const adherenceRows = useMemo(
    () => adherence(scoped, adherencePose),
    [scoped, adherencePose],
  );
  const bmi = useMemo(() => bmiPoints(scoped, bmiPose), [scoped, bmiPose]);
  const bands = useMemo(() => bmiBands(bmi), [bmi]);

  /** One histogram series per cohort, so the distribution is comparable. */
  const histogramSeries = useMemo(() => {
    const collect = (rows: typeof everyone) => {
      const scores: number[] = [];
      for (const row of rows) {
        for (const session of row.sessions) {
          if (cohortPose && session.pose_id !== cohortPose) continue;
          for (const rep of session.reps ?? []) {
            const value = Number(rep.form_score ?? 0);
            if (Number.isFinite(value) && value > 0) scores.push(value);
          }
        }
      }
      return scores;
    };

    const active = enabledCohorts(cohorts);
    if (active.length === 0) {
      return [
        {
          id: "all",
          label: "All patients",
          color: COHORT_COLORS[0],
          scores: collect(everyone),
        },
      ];
    }

    return active.map((cohort, index) => ({
      id: cohort.id,
      label: cohort.name.trim() || `Cohort ${index + 1}`,
      color: COHORT_COLORS[index % COHORT_COLORS.length],
      scores: collect(everyone.filter((row) => matchesCohort(row, cohort))),
    }));
  }, [cohorts, everyone, cohortPose]);

  // Distinguishes "no cohorts configured" from "cohorts exist but nobody has
  // this pose" — the old single message claimed the first in both cases.
  const cohortEmptyMessage =
    enabledCohorts(cohorts).length === 0
      ? "Add a cohort above to compare groups."
      : cohortPose
        ? `No patients in these cohorts have ${poseDisplayLabel(cohortPose)}.`
        : "These cohorts have no recorded sessions yet.";

  const bars = useMemo(
    () => cohortBars(cohorts, everyone, cohortPose),
    [cohorts, everyone, cohortPose],
  );

  /** Individual repetitions behind the means, for the scatter view. */
  const rawValues = useMemo(
    () => cohortValues(cohorts, everyone, cohortPose),
    [cohorts, everyone, cohortPose],
  );

  const scoreSeries = useMemo(
    () =>
      rawValues.map((entry) => ({
        id: entry.id,
        label: entry.label,
        color: entry.color,
        // Scatter follows the basis too: one dot per rep, or per session.
        values: scoreBasis === "rep" ? entry.scores : entry.sessionScores,
      })),
    [rawValues, scoreBasis],
  );

  const holdSeries = useMemo(
    () =>
      rawValues.map((entry) => ({
        id: entry.id,
        label: entry.label,
        color: entry.color,
        values: entry.holds,
      })),
    [rawValues],
  );

  /** Hold time and accuracy paired per repetition, for the relation chart. */
  const relationSeries = useMemo(
    () =>
      rawValues.map((entry) => ({
        id: entry.id,
        label: entry.label,
        color: entry.color,
        points: entry.points.map((point) => ({
          hold: point.hold,
          accuracy: point.score,
        })),
      })),
    [rawValues],
  );


  const genders = useMemo(
    () => [...new Set(everyone.map((row) => row.gender).filter(Boolean))].sort(),
    [everyone],
  );

  const startNewCohort = () => {
    setEditingId(null);
    setEditing(emptyCohort(cohorts.length));
  };

  const toggleCohort = (id: string) =>
    setCohorts((current) =>
      current.map((cohort) =>
        cohort.id === id ? { ...cohort, enabled: cohort.enabled === false } : cohort,
      ),
    );

  const startEditCohort = (cohort: Cohort) => {
    setEditingId(cohort.id);
    setEditing({ ...cohort });
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditingId(null);
  };

  /** Edits are only committed on Save, so Cancel is meaningful. */
  const saveDraft = () => {
    if (!editing) return;
    const position = editingId
      ? cohorts.findIndex((cohort) => cohort.id === editingId)
      : cohorts.length;
    const next: Cohort = {
      ...editing,
      name: editing.name.trim() || `Cohort ${position + 1}`,
    };
    setCohorts((current) =>
      editingId
        ? current.map((cohort) => (cohort.id === editingId ? next : cohort))
        : [...current, next].slice(0, MAX_COHORTS),
    );
    cancelEdit();
  };

  const deleteDraft = () => {
    if (!editingId) return;
    setCohorts((current) => current.filter((cohort) => cohort.id !== editingId));
    cancelEdit();
  };

  // The full-page view should feel like it, not a slightly wider card.
  const expandedHeight = Math.max(380, Math.round(window.innerHeight * 0.62));

  /** Row height that fills the panel without overflowing it. */
  const fitRows = (count: number) =>
    Math.max(32, Math.min(84, Math.floor(expandedHeight / Math.max(1, count))));

  const chartTitles: Record<string, string> = {
    difficulty: "Pose difficulty",
    bmi: "BMI vs pose accuracy",
    adherence: "Adherence",
    histogram: "Repetition accuracy distribution",
    cohortScore: "Pose accuracy by cohort",
    cohortHold: "Hold time per rep by cohort",
    cohortRelation: "Hold time vs pose accuracy",
    cohortSessions: "Sessions by cohort",
  };

  const renderChart = (id: string) => {
    switch (id) {
      case "difficulty":
        return <PoseDifficultyChart rows={difficulty} rowHeight={fitRows(difficulty.length)} />;
      case "bmi":
        return <BmiScoreChart points={bmi} bands={bands} height={expandedHeight} />;
      case "adherence":
        return <AdherenceChart rows={adherenceRows} rowHeight={fitRows(adherenceRows.length)} />;
      case "histogram":
        return <CohortHistogram series={histogramSeries} height={expandedHeight} />;
      case "cohortScore":
        return scoreView === "mean" ? (
          <SegmentComparisonChart
            bars={scoreBasis === "rep" ? bars.formScoreByRep : bars.formScoreBySession}
            unit="%"
            fixedMax={100}
            height={expandedHeight}
          />
        ) : (
          <CohortStripPlot
            series={scoreSeries}
            unit="%"
            fixedMax={100}
            height={expandedHeight}
          />
        );
      case "cohortHold":
        return holdView === "mean" ? (
          <SegmentComparisonChart
            bars={bars.holdPerRep}
            unit="s"
            height={expandedHeight}
          />
        ) : (
          <CohortStripPlot series={holdSeries} unit="s" height={expandedHeight} />
        );
      case "cohortRelation":
        return (
          <CohortRepScatter
            series={relationSeries}
            height={expandedHeight}
            emptyMessage={cohortEmptyMessage}
          />
        );
      case "cohortSessions":
        return sessionsView === "count" ? (
          <SegmentComparisonChart
            bars={bars.sessions}
            unit=""
            height={expandedHeight}
          />
        ) : (
          <CohortScatterPlot
            points={bars.scatter}
            xLabel="sessions"
            yLabel="reps / session"
            height={expandedHeight}
          />
        );
      default:
        return null;
    }
  };

  const chartControls = (id: string) => {
    switch (id) {
      case "cohortScore":
        // Charts would otherwise render empty and read as "no data" rather than
  // "not loaded yet".
  if (loading && patients.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
        Loading clinic data…
      </div>
    );
  }

  return (
          <div className="flex items-center gap-1">
            <Toggle
              value={scoreBasis}
              options={[
                { value: "rep", label: "By rep" },
                { value: "session", label: "By session" },
              ]}
              onChange={setScoreBasis}
            />
            <Toggle
              value={scoreView}
              options={[
                { value: "mean", label: "Mean" },
                { value: "scatter", label: "Scatter" },
              ]}
              onChange={setScoreView}
            />
          </div>
        );
      case "cohortHold":
        return (
          <Toggle
            value={holdView}
            options={[
              { value: "mean", label: "Mean" },
              { value: "scatter", label: "Scatter" },
            ]}
            onChange={setHoldView}
          />
        );
      case "cohortSessions":
        return (
          <Toggle
            value={sessionsView}
            options={[
              { value: "count", label: "Count" },
              { value: "scatter", label: "Scatter" },
            ]}
            onChange={setSessionsView}
          />
        );
      case "bmi":
        return (
          <PoseSelect
            poses={poses}
            value={bmiPose}
            onChange={setBmiPose}
            label="Pose for BMI chart"
          />
        );
      case "adherence":
        return (
          <PoseSelect
            poses={poses}
            value={adherencePose}
            onChange={setAdherencePose}
            label="Pose for adherence"
          />
        );
      default:
        return null;
    }
  };

  const missingBmi = scoped.filter((row) => row.bmi === null).length;

  const activeCohorts = enabledCohorts(cohorts);
  const shownCohorts = activeCohorts.map(
    (cohort, index) => cohort.name.trim() || `Cohort ${index + 1}`,
  );
  const poseFilters = [
    cohortPose ? `Cohorts — ${poseDisplayLabel(cohortPose)}` : "",
    bmiPose ? `BMI — ${poseDisplayLabel(bmiPose)}` : "",
    adherencePose ? `Adherence — ${poseDisplayLabel(adherencePose)}` : "",
  ].filter(Boolean);

  /**
   * Flatten the current chart state into table rows for the workbook.
   *
   * The tables follow the on-screen toggles (mean/scatter, rep/session), so a
   * download cannot silently contradict what the clinician is looking at.
   */
  const buildExportCharts = (): ExportChart[] => {
    const chart = (
      id: string,
      title: string,
      section: ExportChart["section"],
      tables: ExportTable[],
      spec: ExportChartSpec,
    ): ExportChart => ({
      id,
      title,
      section,
      tables,
      chart: { title, ...spec },
    });

    const scoreBars =
      scoreBasis === "rep" ? bars.formScoreByRep : bars.formScoreBySession;
    const scoreTable: ExportTable =
      scoreView === "mean"
        ? {
            columns: [
              "Cohort",
              scoreBasis === "rep"
                ? "Mean accuracy per rep (%)"
                : "Mean accuracy per session (%)",
              "Patients",
              "Observations",
            ],
            rows: scoreBars.map((bar, index) => [
              bar.label,
              roundTo(bar.value),
              bar.patients,
              scoreBasis === "rep"
                ? (rawValues[index]?.scores.length ?? 0)
                : (rawValues[index]?.sessionScores.length ?? 0),
            ]),
          }
        : {
            columns: ["Cohort", "Observations", "Mean (%)", "Minimum (%)", "Maximum (%)"],
            rows: scoreSeries.map((entry) => {
              const stats = summarize(entry.values);
              return stats
                ? [
                    entry.label,
                    stats.count,
                    roundTo(stats.mean),
                    roundTo(stats.min),
                    roundTo(stats.max),
                  ]
                : [entry.label, 0, null, null, null];
            }),
          };

    const scoreChart: ExportChartSpec =
      scoreView === "mean"
        ? {
            type: "column",
            table: 0,
            categoriesColumn: 0,
            series: [{ column: 1, color: COHORT_COLORS[0] }],
            numberFormat: '0"%"',
            dataLabels: true,
            legend: false,
            yTitle: "Pose accuracy (%)",
          }
        : {
            type: "column",
            table: 0,
            categoriesColumn: 0,
            series: [
              { column: 3, name: "Minimum", color: "#94a3b8" },
              { column: 2, name: "Mean", color: COHORT_COLORS[0] },
              { column: 4, name: "Maximum", color: "#f59e0b" },
            ],
            numberFormat: '0"%"',
            dataLabels: true,
            legend: true,
            yTitle: "Pose accuracy (%)",
          };

    const holdTable: ExportTable =
      holdView === "mean"
        ? {
            columns: ["Cohort", "Mean hold per rep (s)", "Patients", "Repetitions"],
            rows: bars.holdPerRep.map((bar, index) => [
              bar.label,
              roundTo(bar.value, 2),
              bar.patients,
              rawValues[index]?.holds.length ?? 0,
            ]),
          }
        : {
            columns: ["Cohort", "Repetitions", "Mean hold (s)", "Minimum (s)", "Maximum (s)"],
            rows: holdSeries.map((entry) => {
              const stats = summarize(entry.values);
              return stats
                ? [
                    entry.label,
                    stats.count,
                    roundTo(stats.mean, 2),
                    roundTo(stats.min, 2),
                    roundTo(stats.max, 2),
                  ]
                : [entry.label, 0, null, null, null];
            }),
          };

    const holdChart: ExportChartSpec =
      holdView === "mean"
        ? {
            type: "column",
            table: 0,
            categoriesColumn: 0,
            series: [{ column: 1, color: COHORT_COLORS[0] }],
            numberFormat: '0.00"s"',
            dataLabels: true,
            legend: false,
            yTitle: "Hold per rep (s)",
          }
        : {
            type: "column",
            table: 0,
            categoriesColumn: 0,
            series: [
              { column: 3, name: "Minimum", color: "#94a3b8" },
              { column: 2, name: "Mean", color: COHORT_COLORS[0] },
              { column: 4, name: "Maximum", color: "#f59e0b" },
            ],
            numberFormat: '0.00"s"',
            dataLabels: true,
            legend: true,
            yTitle: "Hold per rep (s)",
          };

    // The relation chart is a true per-repetition scatter, so the table has one
    // row per point. Rows are grouped by cohort, which gives each series a
    // contiguous range Excel can plot.
    const relationRows: Array<[string, number, number]> = [];
    const relationChartSeries: ExportChartSeries[] = [];
    for (const entry of relationSeries) {
      if (entry.points.length === 0) continue;
      const start = relationRows.length;
      for (const point of entry.points) {
        relationRows.push([entry.label, roundTo(point.hold, 2), roundTo(point.accuracy)]);
      }
      relationChartSeries.push({
        name: entry.label,
        xColumn: 1,
        column: 2,
        rows: { start, end: relationRows.length - 1 },
        color: entry.color,
      });
    }
    const relationTable: ExportTable = {
      columns: ["Cohort", "Hold time (s)", "Pose accuracy (%)"],
      rows: relationRows,
    };
    const relationChart: ExportChartSpec = {
      type: "scatter",
      table: 0,
      series: relationChartSeries,
      xTitle: "Hold time per rep (s)",
      yTitle: "Pose accuracy (%)",
      numberFormat: '0"%"',
      legend: true,
      height: 460,
    };

    const sessionsTable: ExportTable = {
      columns: ["Cohort", "Patients", "Sessions", "Reps per session"],
      rows: bars.sessions.map((bar, index) => [
        bar.label,
        bar.patients,
        bar.sessions,
        roundTo(bars.scatter[index]?.y ?? 0),
      ]),
    };
    const sessionsChart: ExportChartSpec =
      sessionsView === "count"
        ? {
            type: "column",
            table: 0,
            categoriesColumn: 0,
            series: [{ column: 2, name: "Sessions", color: COHORT_COLORS[0] }],
            numberFormat: "0",
            dataLabels: true,
            legend: false,
            yTitle: "Sessions",
          }
        : {
            type: "scatter",
            table: 0,
            series: bars.scatter
              .map((point, index) => ({ point, index }))
              .filter(({ point }) => point.x > 0)
              .map(({ point, index }) => ({
                name: point.label,
                xColumn: 2,
                column: 3,
                rows: { start: index, end: index },
                color: point.color,
              })),
            xTitle: "Sessions",
            yTitle: "Reps per session",
            numberFormat: "0.0",
            legend: true,
          };

    // Transposed so bins run down the rows: that is the orientation Excel needs
    // for one series per cohort across the histogram's categories.
    const histogramCountsBySeries = histogramSeries.map((entry) =>
      histogramCounts(entry.scores),
    );
    const histogramTable: ExportTable = {
      columns: ["Accuracy bucket", ...histogramSeries.map((entry) => entry.label)],
      rows: Array.from({ length: 10 }, (_, bin) => [
        bin === 9 ? "90–100%" : `${bin * 10}–${bin * 10 + 9}%`,
        ...histogramCountsBySeries.map((counts) => counts[bin]),
      ]),
    };
    const histogramChart: ExportChartSpec = {
      type: "column",
      table: 0,
      categoriesColumn: 0,
      series: histogramSeries.some((entry) => entry.scores.length > 0)
        ? histogramSeries.map((entry, index) => ({
            name: entry.label,
            column: index + 1,
            color: entry.color,
          }))
        : [],
      numberFormat: "0",
      legend: true,
      xTitle: "Pose accuracy bucket",
      yTitle: "Repetitions",
      height: 460,
    };

    const difficultyTable: ExportTable = {
      columns: ["Pose", "Minimum (%)", "Mean (%)", "Maximum (%)", "Sessions"],
      rows: difficulty.map((row) => [
        row.label,
        roundTo(row.min),
        roundTo(row.mean),
        roundTo(row.max),
        row.sessions,
      ]),
    };
    const difficultyChart: ExportChartSpec = {
      type: "bar",
      horizontal: true,
      table: 0,
      categoriesColumn: 0,
      series: [
        { column: 1, name: "Minimum", color: "#94a3b8" },
        { column: 2, name: "Mean", color: COHORT_COLORS[0] },
        { column: 3, name: "Maximum", color: "#f59e0b" },
      ],
      numberFormat: '0"%"',
      dataLabels: true,
      legend: true,
      yTitle: "Pose accuracy (%)",
      height: Math.max(420, Math.min(1100, difficulty.length * 34 + 140)),
    };

    const bmiTable: ExportTable = {
      columns: ["Patient", "BMI", "Mean accuracy (%)"],
      rows: bmi.map((point) => [point.name, roundTo(point.bmi), roundTo(point.score)]),
    };

    const bmiBandTable: ExportTable = {
      title: "BMI band summary",
      columns: ["BMI band", "Patients", "Mean BMI", "Mean accuracy (%)"],
      rows: bands.map((band) => {
        const points = bmi.filter(
          (point) => point.bmi >= band.min && point.bmi < band.max,
        );
        const meanBmi = points.length
          ? points.reduce((total, point) => total + point.bmi, 0) / points.length
          : null;
        return [
          band.label,
          band.count,
          meanBmi === null ? null : roundTo(meanBmi),
          band.count > 0 ? roundTo(band.mean) : null,
        ];
      }),
    };
    const bmiChart: ExportChartSpec = {
      type: "scatter",
      table: 0,
      series: bmi.length
        ? [
            {
              table: 0,
              name: "Patients",
              xColumn: 1,
              column: 2,
              color: "#60a5fa",
            },
            {
              table: 1,
              name: "Band averages",
              xColumn: 2,
              column: 3,
              color: COHORT_COLORS[0],
            },
          ]
        : [],
      xTitle: "BMI",
      yTitle: "Mean pose accuracy (%)",
      numberFormat: '0"%"',
      legend: true,
      height: 460,
    };

    const adherenceTable: ExportTable = {
      columns: ["Patient", "Sessions", "Median gap (days)"],
      rows: adherenceRows.map((row) => [
        row.name,
        row.sessions,
        row.medianGapDays === null ? "—" : roundTo(row.medianGapDays),
      ]),
    };
    const adherenceChart: ExportChartSpec = {
      type: "bar",
      horizontal: true,
      table: 0,
      categoriesColumn: 0,
      series: [{ column: 1, name: "Sessions", color: "#a78bfa" }],
      numberFormat: "0",
      legend: false,
      yTitle: "Sessions",
      height: Math.max(420, Math.min(1200, adherenceRows.length * 26 + 120)),
    };

    return [
      chart("cohortScore", "Pose accuracy by cohort", "cohort", [scoreTable], scoreChart),
      chart("cohortHold", "Hold time per rep by cohort", "cohort", [holdTable], holdChart),
      chart(
        "cohortRelation",
        "Hold time vs pose accuracy",
        "cohort",
        [relationTable],
        relationChart,
      ),
      chart(
        "cohortSessions",
        "Sessions by cohort",
        "cohort",
        [sessionsTable],
        sessionsChart,
      ),
      chart(
        "histogram",
        "Repetition accuracy distribution",
        "cohort",
        [histogramTable],
        histogramChart,
      ),
      chart("difficulty", "Pose difficulty", "clinic", [difficultyTable], difficultyChart),
      chart("bmi", "BMI vs pose accuracy", "clinic", [bmiTable, bmiBandTable], bmiChart),
      chart("adherence", "Adherence", "clinic", [adherenceTable], adherenceChart),
    ];
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Analysis</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {scoped.length} patient(s) · {sessions.length} session(s) synced.
            Cohorts below affect only their own charts.
          </p>
        </div>
        <Button variant="outline" onClick={() => setExportOpen(true)}>
          <Download className="h-4 w-4" aria-hidden="true" />
          Download
        </Button>
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

      {/* One block: the cohort editor and the charts it drives, so the grouping
          itself communicates that they are not clinic-wide. */}
      <section className="rounded-card border border-primary/25 bg-primary/[0.04] p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Cohort comparison
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Up to four named groups. Click a cohort to include or exclude it;
              the pencil edits its criteria. These cohorts drive the charts in
              this block only — the rest of the page covers the whole clinic.
              Saved in this browser.
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <PoseSelect
              poses={poses}
              value={cohortPose}
              onChange={setCohortPose}
              label="Pose for cohort comparison"
            />
            <Button
              variant="ghost"
              onClick={startNewCohort}
              disabled={cohorts.length >= MAX_COHORTS}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add cohort
            </Button>
          </div>
        </div>

        <div className="mt-3">
          {cohorts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No cohorts yet — add one to compare groups.
            </p>
          ) : (
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
              {cohorts.map((cohort, index) => {
                const color = COHORT_COLORS[index % COHORT_COLORS.length];
                const included = cohort.enabled !== false;
                // Population matching the cohort, and how many of those
                // actually have the selected pose. With a pose chosen the two
                // differ, and showing only the first overstates the chart.
                const matched = everyone.filter(
                  (row) => row.sessions.length > 0 && matchesCohort(row, cohort),
                ).length;
                const scoped = cohortPose
                  ? everyone.filter(
                      (row) =>
                        matchesCohort(row, cohort) &&
                        row.sessions.some(
                          (session) => session.pose_id === cohortPose,
                        ),
                    ).length
                  : matched;
                const label = cohort.name.trim() || `Cohort ${index + 1}`;
                return (
                  <span
                    key={cohort.id}
                    className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium"
                    style={
                      included
                        ? { borderColor: color, backgroundColor: `${color}22`, color }
                        : { borderColor: "#334155", color: "#64748b" }
                    }
                  >
                    <button
                      type="button"
                      onClick={() => toggleCohort(cohort.id)}
                      aria-pressed={included}
                      title={included ? "Exclude from the charts" : "Include in the charts"}
                      className="inline-flex items-center gap-2"
                    >
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={
                          included
                            ? { backgroundColor: color }
                            : {
                                border: `2px solid ${color}`,
                                backgroundColor: "transparent",
                              }
                        }
                      />
                      <span className={included ? undefined : "line-through"}>
                        {label}
                      </span>
                      <span
                        className="text-muted-foreground"
                        title={
                          isCohortEmpty(cohort)
                            ? "Matches every patient"
                            : cohortPose
                              ? `${scoped} of ${matched} patients have ${poseDisplayLabel(cohortPose)}`
                              : `${matched} patients match this cohort`
                        }
                      >
                        {isCohortEmpty(cohort)
                          ? "all"
                          : cohortPose
                            ? `${scoped}/${matched}`
                            : `${matched}`}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => startEditCohort(cohort)}
                      aria-label={`Edit ${label}`}
                      title="Edit cohort"
                      className="text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Pencil className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ChartCard
            title="Pose accuracy by cohort"
            description={
              scoreView === "mean"
                ? scoreBasis === "rep"
                  ? "Mean of every individual repetition, so sessions with more reps weigh more."
                  : "Mean of each session's average, so every session counts equally."
                : "Every repetition as a dot, with the mean marked — shows how consistent each cohort is."
            }
            onExpand={() => expand("cohortScore")}
            action={chartControls("cohortScore")}
          >
            {scoreView === "mean" ? (
              <SegmentComparisonChart
                bars={
                  scoreBasis === "rep"
                    ? bars.formScoreByRep
                    : bars.formScoreBySession
                }
                unit="%"
                fixedMax={100}
                emptyMessage={cohortEmptyMessage}
              />
            ) : (
              <CohortStripPlot
                series={scoreSeries}
                unit="%"
                fixedMax={100}
                emptyMessage={cohortEmptyMessage}
              />
            )}
          </ChartCard>

          <ChartCard
            title="Hold time per rep by cohort"
            description={
              holdView === "mean"
                ? "Mean hold duration per repetition in each cohort."
                : "Every repetition's hold duration as a dot, with the mean marked."
            }
            onExpand={() => expand("cohortHold")}
            action={chartControls("cohortHold")}
          >
            {holdView === "mean" ? (
              <SegmentComparisonChart
                bars={bars.holdPerRep}
                unit="s"
                emptyMessage={cohortEmptyMessage}
              />
            ) : (
              <CohortStripPlot
                series={holdSeries}
                unit="s"
                emptyMessage={cohortEmptyMessage}
              />
            )}
          </ChartCard>

          <ChartCard
            title="Hold time vs pose accuracy"
            description="Every repetition as a dot: how long the target position was held against how accurate the pose was. Dashed lines are each cohort's trend."
            onExpand={() => expand("cohortRelation")}
          >
            <CohortRepScatter
              series={relationSeries}
              emptyMessage={cohortEmptyMessage}
            />
          </ChartCard>

          <ChartCard
            title="Sessions by cohort"
            description={
              sessionsView === "count"
                ? "Sessions recorded per cohort, annotated with repetitions per session."
                : "Sessions against reps per session — volume versus density."
            }
            onExpand={() => expand("cohortSessions")}
            action={chartControls("cohortSessions")}
          >
            {sessionsView === "count" ? (
              <SegmentComparisonChart
                bars={bars.sessions}
                unit=""
                emptyMessage={cohortEmptyMessage}
              />
            ) : (
              <CohortScatterPlot
                points={bars.scatter}
                xLabel="sessions"
                yLabel="reps / session"
                emptyMessage={cohortEmptyMessage}
              />
            )}
          </ChartCard>

          <ChartCard
            title="Repetition accuracy distribution"
            description="Every repetition from each cohort in ten-point buckets, one colour per cohort. A mean hides whether performance is consistent or split between strong and weak."
            onExpand={() => expand("histogram")}
            className="lg:col-span-2"
          >
            <CohortHistogram
              series={histogramSeries}
              emptyMessage={cohortEmptyMessage}
            />
          </ChartCard>
        </div>
      </section>

      {/* Pose difficulty is the only inherently multi-pose view, so it gets its
          own section instead of sharing the cohort block's pose selector. */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">By exercise</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Spread of session accuracy per pose across the whole clinic — the dot
            is the mean, the bar is the range.
          </p>
        </div>
        <ChartCard
          title="Pose difficulty"
          description="Hardest exercises first, so coaching time goes where it is needed."
          onExpand={() => expand("difficulty")}
        >
          <PoseDifficultyChart rows={difficulty} />
        </ChartCard>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Relationships</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            How performance relates to body composition and attendance.
          </p>
        </div>
        <div className="space-y-4">
          <ChartCard
            title="BMI vs pose accuracy"
            description={`Each dot is a patient; the ringed marker is that band's average.${
              missingBmi > 0
                ? ` ${missingBmi} patient(s) excluded — no usable weight or height.`
                : ""
            }`}
            onExpand={() => expand("bmi")}
            action={chartControls("bmi")}
          >
            <BmiScoreChart points={bmi} bands={bands} />
          </ChartCard>

          <ChartCard
            title="Adherence"
            description="Sessions per patient and the median gap between them."
            onExpand={() => expand("adherence")}
            action={chartControls("adherence")}
          >
            <AdherenceChart rows={adherenceRows} />
          </ChartCard>
        </div>
      </section>

      {loading && <p className="text-xs text-muted-foreground">Loading clinic data…</p>}

      <Modal
        open={editing !== null}
        title={editingId ? "Edit cohort" : "New cohort"}
        onClose={cancelEdit}
        footer={
          <>
            {editingId && (
              <Button
                variant="ghost"
                onClick={deleteDraft}
                className="mr-auto text-red-400"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete
              </Button>
            )}
            <Button variant="ghost" onClick={cancelEdit}>
              Cancel
            </Button>
            <Button onClick={saveDraft}>Save</Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            <label className="block text-xs text-muted-foreground">
              Name
              <input
                autoFocus
                value={editing.name}
                onChange={(event) =>
                  setEditing({ ...editing, name: event.target.value })
                }
                className="mt-1 h-8 w-full rounded-control border border-border bg-background px-2 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            </label>

            {COHORT_RANGES.map(([minKey, maxKey, label]) => (
              <div
                key={minKey}
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <span className="w-14 shrink-0">{label}</span>
                <input
                  type="number"
                  value={editing[minKey] as string}
                  placeholder="min"
                  aria-label={`${label} minimum`}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      [minKey]: event.target.value,
                    } as Cohort)
                  }
                  className="h-8 min-w-0 flex-1 rounded-control border border-border bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
                />
                <span className="text-muted-foreground/70">–</span>
                <input
                  type="number"
                  value={editing[maxKey] as string}
                  placeholder="max"
                  aria-label={`${label} maximum`}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      [maxKey]: event.target.value,
                    } as Cohort)
                  }
                  className="h-8 min-w-0 flex-1 rounded-control border border-border bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none"
                />
              </div>
            ))}

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="w-14 shrink-0">Gender</span>
              <select
                value={editing.gender}
                onChange={(event) =>
                  setEditing({ ...editing, gender: event.target.value })
                }
                className="h-8 min-w-0 flex-1 rounded-control border border-border bg-background px-2 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                <option value="">Any</option>
                {genders.map((gender) => (
                  <option key={gender} value={gender}>
                    {gender}
                  </option>
                ))}
              </select>
            </label>

            {isCohortEmpty(editing) && (
              <p className="text-[11px] text-muted-foreground">
                No criteria set — this cohort matches every patient.
              </p>
            )}
          </div>
        )}
      </Modal>

      <AnalysisExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        getCharts={buildExportCharts}
        cohorts={shownCohorts}
        poseFilters={poseFilters}
        patients={scoped.length}
        sessions={sessions.length}
      />

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
