import { poseDisplayLabel } from "@pilates/types";

export interface PoseSelectProps {
  /** Pose ids present in the data. */
  poses: string[];
  value: string;
  onChange: (next: string) => void;
  label: string;
}

/** Compact pose selector shared by the charts that support one. */
export function PoseSelect({ poses, value, onChange, label }: PoseSelectProps) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={label}
      className="h-7 max-w-[10rem] rounded-control border border-border bg-background px-1.5 text-xs text-foreground focus:border-primary focus:outline-none"
    >
      <option value="">All poses</option>
      {poses.map((poseId) => (
        <option key={poseId} value={poseId}>
          {poseDisplayLabel(poseId)}
        </option>
      ))}
    </select>
  );
}
