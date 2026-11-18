import * as React from "react";
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import type { FormScoreBreakdown } from "@pilates/types";
import { cn } from "@pilates/ui";

export interface FormScoreRadarProps {
  breakdown: FormScoreBreakdown;
  height?: number;
  className?: string;
  /** Compare against a patient baseline (e.g. lifetime average). */
  baseline?: FormScoreBreakdown;
}

interface RadarDatum {
  axis: string;
  value: number;
  baseline: number | null;
}

const AXES: { key: keyof FormScoreBreakdown; axis: string }[] = [
  { key: "angle_accuracy", axis: "Angle accuracy" },
  { key: "stability", axis: "Stability" },
  { key: "speed", axis: "Speed" },
  { key: "detection_confidence", axis: "Detection" },
];

/**
 * Radar breakdown of the composite pose accuracy into its four weighted
 * components, optionally overlaid on a historical patient baseline.
 */
export function FormScoreRadar({
  breakdown,
  height = 260,
  className,
  baseline,
}: FormScoreRadarProps) {
  const data = React.useMemo<RadarDatum[]>(
    () =>
      AXES.map(({ key, axis }) => ({
        axis,
        value: Number.isFinite(breakdown[key]) ? breakdown[key] : 0,
        baseline:
          baseline && Number.isFinite(baseline[key]) ? baseline[key] : null,
      })),
    [breakdown, baseline],
  );

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} outerRadius="72%">
          <PolarGrid stroke="#332e28" />
          <PolarAngleAxis
            dataKey="axis"
            tick={{ fill: "#a8a29e", fontSize: 11 }}
          />
          <PolarRadiusAxis
            domain={[0, 100]}
            tick={{ fill: "#78716c", fontSize: 10 }}
            axisLine={false}
            tickCount={4}
          />

          {baseline && (
            <Radar
              name="baseline"
              dataKey="baseline"
              stroke="#a8a29e"
              fill="#a8a29e"
              fillOpacity={0.12}
              strokeDasharray="4 3"
              isAnimationActive={false}
            />
          )}

          <Radar
            name="pose accuracy"
            dataKey="value"
            stroke="#2dd4bf"
            fill="#2dd4bf"
            fillOpacity={0.28}
            isAnimationActive={false}
          />

          <Tooltip
            contentStyle={{
              background: "#1c1917",
              border: "1px solid #3f3a34",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "#a8a29e" }}
            formatter={(value) => `${Number(value).toFixed(1)}%`}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}
