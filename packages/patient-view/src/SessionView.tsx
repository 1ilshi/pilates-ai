import { ArrowLeft, CheckCircle2, Clock, CloudUpload, Download, Play } from "lucide-react";
import { RepTimelineChart } from "@pilates/viz";
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
import type { SessionDetailLike } from "./types";

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

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <span className="text-xs text-slate-400">{label}</span>
      <p className="mt-1 text-2xl font-bold text-slate-100">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </Card>
  );
}

export interface SessionViewProps {
  session: SessionDetailLike;
  patientName?: string;
  onBack?: () => void;
  backLabel?: string;
  /** Desktop only: jump straight into another recording. */
  onNewSession?: () => void;
  /** Portal only: resolve the Parquet archive download. */
  onDownloadTelemetry?: () => Promise<void>;
}

/**
 * Full analysis of one recorded session, shared by the desktop app and the
 * portal so the two cannot drift. The only differences are the optional
 * actions each surface passes in.
 */
export function SessionView({
  session,
  patientName,
  onBack,
  backLabel = "Patient",
  onNewSession,
  onDownloadTelemetry,
}: SessionViewProps) {
  const summary = session.summary ?? {};
  const reps = session.reps ?? [];
  const curve = session.kinematic_curve ?? [];
  const telemetry = session.research_telemetry ?? null;

  const meanHold = reps.length
    ? reps.reduce((sum, rep) => sum + Number(rep.duration_sec ?? 0), 0) / reps.length
    : 0;

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
          <h3 className="text-xl font-semibold text-slate-100">
            {poseDisplayLabel(session.pose_id)}
          </h3>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1 text-slate-400">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {formatDateTime(session.completed_at)}
            </span>
            {patientName && <span>· {patientName}</span>}
            <span>· model {session.model_version || "—"}</span>
            <span>· {session.session_id.slice(0, 8)}</span>
          </p>
        </div>

        <div className="flex items-center gap-2">
          {onDownloadTelemetry && telemetry?.storage_path && (
            <Button variant="secondary" onClick={() => void onDownloadTelemetry()}>
              <Download className="h-4 w-4" aria-hidden="true" />
              Download archive
            </Button>
          )}
          {onNewSession && (
            <Button onClick={onNewSession}>
              <Play className="h-4 w-4" aria-hidden="true" />
              New session
            </Button>
          )}
        </div>
      </div>

      {/* Headline numbers ---------------------------------------------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Repetitions" value={String(summary.total_reps ?? reps.length)} />
        <Stat
          label="Mean form score"
          value={
            summary.mean_form_score !== undefined
              ? formatPercent(summary.mean_form_score, 0)
              : "—"
          }
          hint="across every repetition"
        />
        <Stat
          label="Peak ROM"
          value={
            summary.peak_rom_angle !== undefined
              ? `${summary.peak_rom_angle.toFixed(1)}°`
              : "—"
          }
          hint="largest angle reached"
        />
        <Stat
          label="Hold time"
          value={meanHold > 0 ? `${meanHold.toFixed(1)}s` : "—"}
          hint="mean per repetition"
        />
      </div>

      {/* Trajectory ----------------------------------------------------- */}
      <Card>
        <CardHeader className="pb-0">
          <CardTitle>Angle trajectory</CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            Primary joint angle over the session, with the form score overlay.
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          {curve.length > 0 ? (
            <RepTimelineChart data={curve} showScore height={280} />
          ) : (
            <p className="py-6 text-center text-xs text-slate-500">
              No kinematic curve recorded for this session.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Repetitions ----------------------------------------------------- */}
      <Card>
        <CardHeader className="pb-0">
          <CardTitle>Repetition breakdown</CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            {reps.length} repetition(s) · completion{" "}
            {summary.completion_rate !== undefined
              ? formatPercent(summary.completion_rate, 0)
              : "—"}
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          {reps.length > 0 ? (
            <>
            {/* Phones get one block per repetition: six numeric columns cannot
                be read at 390px. */}
            <div className="space-y-2 sm:hidden">
              {reps.map((rep) => (
                <div
                  key={rep.rep_index}
                  className="rounded-card border border-slate-800 bg-slate-900/30 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-300">
                      Rep {rep.rep_index}
                    </span>
                    <span className="text-sm font-semibold text-slate-100">
                      {formatPercent(Number(rep.form_score ?? 0), 0)}
                    </span>
                  </div>
                  <dl className="mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
                    <div>
                      <dt className="text-slate-500">Duration</dt>
                      <dd className="text-slate-300">
                        {Number(rep.duration_sec ?? 0).toFixed(1)}s
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Peak ROM</dt>
                      <dd className="text-slate-300">
                        {Number(rep.peak_rom_angle ?? 0).toFixed(1)}°
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Stability</dt>
                      <dd className="text-slate-300">
                        {rep.stability_variance !== undefined
                          ? Number(rep.stability_variance).toFixed(2)
                          : "—"}
                      </dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>

            <div className="hidden sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Peak ROM</TableHead>
                  <TableHead>Hold</TableHead>
                  <TableHead>Form</TableHead>
                  <TableHead>Stability</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reps.map((rep) => (
                  <TableRow key={rep.rep_index}>
                    <TableCell className="text-slate-400">{rep.rep_index}</TableCell>
                    <TableCell className="text-slate-400">
                      {Number(rep.duration_sec ?? 0).toFixed(1)}s
                    </TableCell>
                    <TableCell className="text-slate-400">
                      {Number(rep.peak_rom_angle ?? 0).toFixed(1)}°
                    </TableCell>
                    <TableCell className="text-slate-400">
                      {Number(rep.duration_sec ?? 0).toFixed(1)}s
                    </TableCell>
                    <TableCell>{formatPercent(Number(rep.form_score ?? 0), 0)}</TableCell>
                    <TableCell className="text-slate-400">
                      {rep.stability_variance !== undefined
                        ? Number(rep.stability_variance).toFixed(2)
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
            </>
          ) : (
            <p className="py-6 text-center text-xs text-slate-500">
              No per-repetition detail recorded for this session.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Telemetry ------------------------------------------------------- */}
      <Card>
        <CardHeader className="pb-0">
          <CardTitle className="flex items-center gap-2">
            <CloudUpload className="h-4 w-4 text-brand-400" aria-hidden="true" />
            Research telemetry
            {telemetry?.storage_path ? (
              <Badge variant="success">
                <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" />
                archived
              </Badge>
            ) : (
              <Badge variant="neutral">not captured</Badge>
            )}
          </CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            The raw frame archive is optional cold storage; the session document
            above is the clinical record.
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          {telemetry?.storage_path ? (
            <div className="space-y-1.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-slate-500">Archive path</span>
                <span className="break-all text-right font-mono text-xs text-slate-300">
                  {telemetry.storage_path}
                </span>
              </div>
              {telemetry.sha256 && (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs text-slate-500">SHA-256</span>
                  <span className="break-all text-right font-mono text-xs text-slate-300">
                    {telemetry.sha256}
                  </span>
                </div>
              )}
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-slate-500">Parquet size</span>
                <span className="text-slate-300">
                  {telemetry.file_size_bytes
                    ? `${(telemetry.file_size_bytes / 1024).toFixed(1)} KB`
                    : "—"}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-slate-500">Frames</span>
                <span className="text-slate-300">{telemetry.frame_count ?? "—"}</span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              No archive was written for this session — a Cloud Storage bucket
              must be configured to capture raw frames.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
