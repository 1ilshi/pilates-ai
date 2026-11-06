import * as React from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DownsampledPoint, TargetRom } from "@pilates/types";
import { cn } from "@pilates/ui";

export interface RepTimelineChartProps {
  /** Downsampled kinematic curve (2 Hz) from the session document. */
  data: DownsampledPoint[];
  /** Target ROM band drawn as a highlighted horizontal region. */
  targetRom?: TargetRom;
  /** Draw the instantaneous form score on a second axis. */
  showScore?: boolean;
  height?: number;
  className?: string;
}

interface HoldRange {
  start: number;
  end: number;
}

/** Derive contiguous `holding` phase ranges so they can be shaded. */
export function deriveHoldRanges(data: DownsampledPoint[]): HoldRange[] {
  const ranges: HoldRange[] = [];
  let open: HoldRange | null = null;

  for (const point of data) {
    if (point.phase === "holding") {
      if (open) {
        open.end = point.t_sec;
      } else {
        open = { start: point.t_sec, end: point.t_sec };
      }
    } else if (open) {
      ranges.push(open);
      open = null;
    }
  }
  if (open) ranges.push(open);
  return ranges.filter((r) => r.end > r.start);
}

/**
 * Angle trajectory over time with hold zones highlighted and the clinical
 * target band shaded. Used for post-session review and live replay.
 */
export function RepTimelineChart({
  data,
  targetRom,
  showScore = false,
  height = 260,
  className,
}: RepTimelineChartProps) {
  const holdRanges = React.useMemo(() => deriveHoldRanges(data), [data]);

  const yDomain = React.useMemo<[number, number]>(() => {
    const angles = data.map((d) => d.angle).filter(Number.isFinite);
    const candidates = targetRom
      ? [...angles, targetRom.min, targetRom.max]
      : angles;
    if (!candidates.length) return [0, 180];
    const lo = Math.min(...candidates);
    const hi = Math.max(...candidates);
    const pad = Math.max(5, (hi - lo) * 0.1);
    return [Math.max(0, Math.floor(lo - pad)), Math.min(180, Math.ceil(hi + pad))];
  }, [data, targetRom]);

  if (!data.length) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-card border border-slate-800 bg-slate-900/30 text-sm text-slate-500",
          className,
        )}
        style={{ height }}
      >
        No kinematic data for this session
      </div>
    );
  }

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />

          {targetRom && (
            <ReferenceArea
              y1={targetRom.min}
              y2={targetRom.max}
              fill="#22c55e"
              fillOpacity={0.08}
              stroke="none"
            />
          )}
          {targetRom && (
            <ReferenceLine
              y={targetRom.target}
              stroke="#22c55e"
              strokeDasharray="4 4"
              strokeOpacity={0.7}
              label={{
                value: `target ${targetRom.target}\u00b0`,
                position: "insideTopRight",
                fill: "#4ade80",
                fontSize: 11,
              }}
            />
          )}

          {holdRanges.map((range, index) => (
            <ReferenceArea
              key={`hold-${index}`}
              x1={range.start}
              x2={range.end}
              fill="#34d399"
              fillOpacity={0.12}
              stroke="none"
            />
          ))}

          <XAxis
            dataKey="t_sec"
            stroke="#64748b"
            tick={{ fontSize: 11 }}
            tickFormatter={(value: number) => `${value}s`}
          />
          <YAxis
            yAxisId="angle"
            domain={yDomain}
            stroke="#64748b"
            tick={{ fontSize: 11 }}
            tickFormatter={(value: number) => `${value}\u00b0`}
            width={44}
          />
          {showScore && (
            <YAxis
              yAxisId="score"
              orientation="right"
              domain={[0, 100]}
              stroke="#64748b"
              tick={{ fontSize: 11 }}
              tickFormatter={(value: number) => `${value}%`}
              width={44}
            />
          )}

          <Tooltip
            contentStyle={{
              background: "#0f172a",
              border: "1px solid #1e293b",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "#94a3b8" }}
            labelFormatter={(value) => `t = ${value}s`}
            formatter={(value, name) =>
              name === "angle"
                ? [`${Number(value).toFixed(1)}\u00b0`, "angle"]
                : [`${Number(value).toFixed(1)}%`, "score"]
            }
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />

          <Line
            yAxisId="angle"
            type="monotone"
            dataKey="angle"
            name="angle"
            stroke="#2dd4bf"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          {showScore && (
            <Line
              yAxisId="score"
              type="monotone"
              dataKey="score"
              name="score"
              stroke="#a78bfa"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
