import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Button, cn } from "@pilates/ui";
import { Modal } from "./Modal";
import {
  exportAnalysisToExcel,
  type ExportChart,
  type ExportContent,
  type ExportScope,
} from "../lib/analysisExport";

export interface AnalysisExportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Built when the download starts, so it sees the latest chart state. */
  getCharts: () => ExportChart[];
  cohorts: string[];
  poseFilters: string[];
  patients: number;
  sessions: number;
}

const SCOPE_OPTIONS: Array<{
  value: ExportScope;
  label: string;
  description: string;
}> = [
  {
    value: "cohort",
    label: "Cohort charts only",
    description:
      "The charts driven by the cohorts above: accuracy, hold time, relation, sessions and distribution.",
  },
  {
    value: "all",
    label: "All charts",
    description:
      "Every chart on this page — the cohort charts plus pose difficulty, BMI and adherence.",
  },
];

const CONTENT_OPTIONS: Array<{
  value: ExportContent;
  label: string;
  description: string;
}> = [
  {
    value: "graphs",
    label: "Graphs only",
    description: "One editable Excel chart per sheet, with the data on a hidden sheet.",
  },
  {
    value: "tables",
    label: "Graphs + tables",
    description: "Each editable Excel chart followed by the table of values behind it.",
  },
];

/**
 * Export options for the analysis page.
 *
 * The file is a snapshot, not a live report, so the dialog repeats what the
 * current page is showing before anything is downloaded.
 */
export function AnalysisExportDialog({
  open,
  onClose,
  getCharts,
  cohorts,
  poseFilters,
  patients,
  sessions,
}: AnalysisExportDialogProps) {
  const [scope, setScope] = useState<ExportScope>("cohort");
  const [content, setContent] = useState<ExportContent>("tables");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setError(null);
      setStatus(null);
    }
  }, [open]);

  const download = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const charts = getCharts().filter(
        (chart) => scope === "all" || chart.section === "cohort",
      );
      const result = await exportAnalysisToExcel(charts, {
        scope,
        includeTables: content === "tables",
        cohorts,
        poseFilters,
        patients,
        sessions,
      });
      setStatus(
        result.failedCharts.length === 0
          ? `Downloaded ${result.charts} native Excel chart(s) as ${result.fileName}.`
          : `Downloaded ${result.fileName}. ${result.failedCharts.length} chart(s) could not be written; their sheets and data are still included.`,
      );
    } catch (caught) {
      setError((caught as Error).message || "The workbook could not be built.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Download analysis"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button onClick={() => void download()} loading={busy}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Download Excel
          </Button>
        </>
      }
    >
      <div className="space-y-5 text-xs">
        <div className="rounded-xl border border-primary/30 bg-primary/[0.06] p-4 text-[11px] leading-relaxed text-foreground/80">
          <p className="font-medium text-primary">
            This download shows the cohorts currently displayed.
          </p>
          <p className="mt-1 text-muted-foreground">
            {cohorts.length > 0
              ? `Included: ${cohorts.join(", ")}. Disabled cohorts are left out.`
              : "No cohorts are enabled, so the cohort charts cover all patients."}{" "}
            Charts outside the cohort section always cover the whole clinic.
          </p>
        </div>

        <fieldset className="space-y-2">
          <legend className="mb-2 text-xs font-semibold text-foreground">
            Which charts
          </legend>
          {SCOPE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors",
                scope === option.value
                  ? "border-primary/60 bg-primary/10"
                  : "border-border hover:border-muted-foreground/40",
              )}
            >
              <input
                type="radio"
                name="analysis-export-scope"
                value={option.value}
                checked={scope === option.value}
                onChange={() => {
                  setScope(option.value);
                  setStatus(null);
                }}
                className="mt-0.5 accent-primary"
              />
              <span>
                <span className="block text-xs font-medium text-foreground">
                  {option.label}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="mb-2 text-xs font-semibold text-foreground">
            What to include
          </legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {CONTENT_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer gap-2 rounded-xl border p-4 transition-colors",
                  content === option.value
                    ? "border-primary/60 bg-primary/10"
                    : "border-border hover:border-muted-foreground/40",
                )}
              >
                <input
                  type="radio"
                  name="analysis-export-content"
                  value={option.value}
                  checked={content === option.value}
                  onChange={() => {
                    setContent(option.value);
                    setStatus(null);
                  }}
                  className="mt-0.5 accent-primary"
                />
                <span>
                  <span className="block text-xs font-medium text-foreground">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <p className="text-[11px] text-muted-foreground">
          {poseFilters.length > 0
            ? `Pose filters applied on screen are kept: ${poseFilters.join(" · ")}.`
            : "No pose filter is applied on screen, so every pose is included."}
        </p>

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-red-300"
          >
            {error}
          </p>
        )}
        {status && (
          <p
            role="status"
            className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-primary"
          >
            {status}
          </p>
        )}
      </div>
    </Modal>
  );
}
