import { cn } from "@pilates/ui";

export interface JointAngleGaugeProps {
  /** Current measured joint angle in degrees. */
  angle: number;
  /** Clinically targeted angle in degrees. */
  target: number;
  /** Lower bound of the gauge scale. */
  min?: number;
  /** Upper bound of the gauge scale. */
  max?: number;
  /** Half-width of the acceptable band drawn around `target`. */
  tolerance?: number;
  /** Joint name shown under the value, e.g. `knee_flexion`. */
  label?: string;
  size?: number;
  className?: string;
}

const SWEEP_START = -135;
const SWEEP_DEGREES = 270;

function polar(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

function describeArc(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = polar(cx, cy, radius, startAngle);
  const end = polar(cx, cy, radius, endAngle);
  const largeArc = Math.abs(endAngle - startAngle) > 180 ? 1 : 0;
  const sweep = endAngle >= startAngle ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${end.x} ${end.y}`;
}

/**
 * Circular gauge showing the current joint angle against the pose's clinical
 * target. The target tolerance band is drawn in green; the needle and value
 * turn amber/red as the patient drifts away from it.
 */
export function JointAngleGauge({
  angle,
  target,
  min = 0,
  max = 180,
  tolerance = 10,
  label,
  size = 220,
  className,
}: JointAngleGaugeProps) {
  const span = Math.max(1e-6, max - min);
  const clampValue = (v: number) => Math.min(max, Math.max(min, v));
  const toAngle = (v: number) =>
    SWEEP_START + ((clampValue(v) - min) / span) * SWEEP_DEGREES;

  const center = size / 2;
  const radius = size / 2 - 18;
  const hasReading = Number.isFinite(angle);
  const deviation = hasReading ? Math.abs(angle - target) : Number.NaN;

  const status: "in_range" | "near" | "off" = !hasReading
    ? "off"
    : deviation <= tolerance
      ? "in_range"
      : deviation <= tolerance * 2
        ? "near"
        : "off";

  const statusColor =
    status === "in_range" ? "#22c55e" : status === "near" ? "#eab308" : "#ef4444";

  const bandStart = toAngle(target - tolerance);
  const bandEnd = toAngle(target + tolerance);
  const valueAngle = hasReading ? toAngle(angle) : SWEEP_START;
  const needle = polar(center, center, radius - 6, valueAngle);
  const valueText = hasReading ? `${angle.toFixed(1)}\u00b0` : "--";

  return (
    <div
      className={cn("inline-flex flex-col items-center", className)}
      role="meter"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={hasReading ? Number(angle.toFixed(1)) : undefined}
      aria-valuetext={
        hasReading
          ? `${angle.toFixed(1)} degrees, target ${target} degrees`
          : "No reading"
      }
      aria-label={label ?? "Joint angle"}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Track */}
        <path
          d={describeArc(center, center, radius, SWEEP_START, SWEEP_START + SWEEP_DEGREES)}
          fill="none"
          stroke="#1e293b"
          strokeWidth={12}
          strokeLinecap="round"
        />

        {/* Acceptable target band */}
        <path
          d={describeArc(center, center, radius, bandStart, bandEnd)}
          fill="none"
          stroke="#22c55e"
          strokeOpacity={0.35}
          strokeWidth={12}
        />

        {/* Progress arc to the current value */}
        {hasReading && (
          <path
            d={describeArc(center, center, radius, SWEEP_START, valueAngle)}
            fill="none"
            stroke={statusColor}
            strokeWidth={12}
            strokeLinecap="round"
          />
        )}

        {/* Target tick */}
        <line
          {...(() => {
            const outer = polar(center, center, radius + 8, toAngle(target));
            const inner = polar(center, center, radius - 8, toAngle(target));
            return { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y };
          })()}
          stroke="#e2e8f0"
          strokeWidth={2}
        />

        {/* Needle */}
        {hasReading && (
          <line
            x1={center}
            y1={center}
            x2={needle.x}
            y2={needle.y}
            stroke={statusColor}
            strokeWidth={2.5}
            strokeLinecap="round"
          />
        )}
        <circle cx={center} cy={center} r={4} fill="#94a3b8" />

        {/* Value readout */}
        <text
          x={center}
          y={center + radius * 0.42}
          textAnchor="middle"
          fill="#f1f5f9"
          fontSize={size * 0.15}
          fontWeight={700}
        >
          {valueText}
        </text>
        <text
          x={center}
          y={center + radius * 0.66}
          textAnchor="middle"
          fill="#94a3b8"
          fontSize={size * 0.055}
        >
          {`target ${target}\u00b0`}
        </text>
      </svg>

      {label && (
        <span className="mt-1 text-xs font-medium text-slate-400">{label}</span>
      )}
    </div>
  );
}
