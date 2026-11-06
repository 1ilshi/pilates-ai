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
      className="h-7 max-w-[10rem] rounded-control border border-slate-700 bg-slate-950 px-1.5 text-xs text-slate-100 focus:border-brand-500 focus:outline-none"
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
