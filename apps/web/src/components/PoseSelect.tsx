import { poseDisplayLabel } from "@pilates/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@pilates/ui";

export interface PoseSelectProps {
  /** Pose ids present in the data. */
  poses: string[];
  /** Selected pose id, or "" for all poses. */
  value: string;
  onChange: (next: string) => void;
  label: string;
}

/** Compact pose selector shared by the charts that support one. */
export function PoseSelect({ poses, value, onChange, label }: PoseSelectProps) {
  // Radix forbids empty-string item values, so "all poses" travels as a
  // sentinel and is translated back to "" at the boundary.
  const ALL = "__all__";
  return (
    <Select
      value={value || ALL}
      onValueChange={(next) => onChange(next === ALL ? "" : next)}
    >
      <SelectTrigger size="sm" aria-label={label} className="max-w-[10rem]">
        <SelectValue placeholder="All poses" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All poses</SelectItem>
        {poses.map((poseId) => (
          <SelectItem key={poseId} value={poseId}>
            {poseDisplayLabel(poseId)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
