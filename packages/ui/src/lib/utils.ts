import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names, resolving Tailwind conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Format a 0-100 score as a percentage string, e.g. `92.4%`. */
export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "--";
  return `${value.toFixed(digits)}%`;
}

/** Format a joint angle in degrees, e.g. `115.2°`. */
export function formatAngle(degrees: number, digits = 1): string {
  if (!Number.isFinite(degrees)) return "--";
  return `${degrees.toFixed(digits)}\u00b0`;
}

/** Format a duration in seconds as `m:ss` when it exceeds a minute. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "--";
  const seconds = Math.floor(totalSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Clamp a number into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
