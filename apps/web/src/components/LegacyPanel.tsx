import { Snowflake } from "lucide-react";
import {
  Badge,
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
import { formatDate, type LegacySummary } from "../lib/legacy";

/**
 * Read-only view of the FlutterFlow-era statistics.
 *
 * Kept visually distinct from current sessions on purpose: legacy `accuracy` is
 * a classification score, not the biomechanical form score, so the two must
 * never be plotted together or averaged.
 */
export function LegacyPanel({ legacy }: { legacy: LegacySummary }) {
  const rows = Object.entries(legacy.poses)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pose, summary]) => ({ pose, ...summary }));

  return (
    <Card>
      <CardHeader className="pb-0">
        <CardTitle className="flex items-center gap-2">
          <Snowflake className="h-4 w-4 text-amber-400" aria-hidden="true" />
          Legacy history
          <Badge variant="warning">Read-only</Badge>
        </CardTitle>
        <p className="mt-1 text-xs text-slate-500">
          Recorded by the previous application. Last sample {formatDate(legacy.last_sample_at)} —
          these figures are frozen and will not update. They measure classification{" "}
          <em>accuracy</em>, a different metric from the form score.
        </p>
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-card border border-slate-800 bg-slate-900/40 p-3">
            <p className="text-xs text-slate-500">Samples</p>
            <p className="text-xl font-bold text-slate-100">{legacy.total_samples}</p>
          </div>
          <div className="rounded-card border border-slate-800 bg-slate-900/40 p-3">
            <p className="text-xs text-slate-500">Poses</p>
            <p className="text-xl font-bold text-slate-100">{rows.length}</p>
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
            {rows.map((row) => (
              <TableRow key={row.pose}>
                <TableCell className="font-medium capitalize">{row.pose}</TableCell>
                <TableCell className="text-slate-400">{row.count}</TableCell>
                <TableCell>{formatPercent(row.avg, 1)}</TableCell>
                <TableCell className="text-slate-400">
                  {row.min.toFixed(1)}–{row.max.toFixed(1)}%
                </TableCell>
                <TableCell className="text-slate-400">{formatDate(row.last_sample_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
