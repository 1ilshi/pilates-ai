import { useCallback, useEffect, useMemo, useState } from "react";
import { signalSync } from "../lib/syncSignal";
import { Search, UserPlus, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  Dialog,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@pilates/ui";
import {
  deletePatient,
  isTauri,
  listPatients,
  savePatient,
  type PatientInput,
  type PatientRecord,
} from "../lib/ipc";

export interface PatientListPageProps {
  onSelectPatient: (patient: PatientRecord) => void;
  /** Lets the shell drop a patient that has just been deleted. */
  onPatientDeleted?: (patientId: string) => void;
}

/** `5 Nov 2026` — matches the rest of the app. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const EMPTY_FORM: PatientInput = {
  name: "",
  age: "",
  weight: "",
  height: "",
  gender: "Female",
};

const GENDERS = ["Female", "Male"] as const;

const FIELD_CLASSES = cn(
  "h-9 w-full rounded-control border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100",
  "focus:border-brand-500 focus:outline-none",
);

/** Digits only — age is a whole number of years. */
function sanitizeInteger(value: string): string {
  return value.replace(/\D+/g, "");
}

/** Digits plus at most one decimal point — weight/height in kg/cm. */
function sanitizeDecimal(value: string): string {
  const cleaned = value.replace(/[^0-9.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  return rest.length ? `${whole}.${rest.join("")}` : whole;
}

type SortKey = "name" | "gender" | "age" | "sessions" | "score" | "lastActive";

/** Click a column once to sort ascending, again to reverse. */
function SortHeader({
  label,
  column,
  active,
  descending,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  active: SortKey;
  descending: boolean;
  onSort: (column: SortKey) => void;
  className?: string;
}) {
  const isActive = active === column;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        aria-label={`Sort by ${label}`}
        className={
          isActive
            ? "inline-flex items-center gap-1 font-semibold text-brand-400"
            : "inline-flex items-center gap-1 text-slate-400 hover:text-slate-200"
        }
      >
        {label}
        <span className="text-[9px]">
          {isActive ? (descending ? "\u25bc" : "\u25b2") : "\u2195"}
        </span>
      </button>
    </TableHead>
  );
}

export function PatientListPage({ onSelectPatient, onPatientDeleted }: PatientListPageProps) {
  const [patients, setPatients] = useState<PatientRecord[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<PatientInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);
  const native = isTauri();

  const refresh = useCallback(async () => {
    if (!native) return;
    setError(null);
    try {
      setPatients(await listPatients());
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  }, [native]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Sync runs in the background; reload whenever it changes anything.
  useEffect(() => {
    const onChanged = () => void refresh();
    window.addEventListener("pilates:data-changed", onChanged);
    return () => window.removeEventListener("pilates:data-changed", onChanged);
  }, [refresh]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return patients;
    return patients.filter(
      (patient) =>
        patient.name.toLowerCase().includes(needle) ||
        patient.gender.toLowerCase().includes(needle),
    );
  }, [patients, query]);

  const onSort = (column: SortKey) => {
    if (column === sortKey) {
      setDescending((current) => !current);
    } else {
      setSortKey(column);
      setDescending(false);
    }
  };

  const sorted = useMemo(() => {
    const value = (patient: PatientRecord): string | number => {
      switch (sortKey) {
        case "gender":
          return (patient.gender ?? "").toLowerCase();
        case "age":
          return Number.parseFloat(patient.age ?? "") || 0;
        case "sessions":
          return patient.total_sessions ?? 0;
        case "score":
          return patient.lifetime_avg_score ?? -1;
        case "lastActive":
          return Date.parse(patient.last_active ?? "") || 0;
        default:
          return patient.name.toLowerCase();
      }
    };
    const rows = [...filtered].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      if (typeof left === "number" && typeof right === "number") {
        return left - right;
      }
      return String(left).localeCompare(String(right));
    });
    return descending ? rows.reverse() : rows;
  }, [filtered, sortKey, descending]);

  const submit = async () => {
    if (!form.name.trim()) {
      setError("A patient name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await savePatient(form);
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      await refresh();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (patient: PatientRecord) => {
    try {
      await deletePatient(patient.id);
      signalSync();
      onPatientDeleted?.(patient.id);
      await refresh();
    } catch (caught) {
      setError(String(caught));
    }
  };

  return (
    <div className="space-y-5">
      {!native && (
        <Card className="border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-300">
          Running in a browser: the native engine is unavailable. Launch with{" "}
          <code className="rounded bg-slate-800 px-1">pnpm tauri dev</code> to load
          patients.
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search patients by name…"
            aria-label="Search patients"
            className="h-10 w-full rounded-control border border-slate-800 bg-slate-900/60 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-brand-500 focus:outline-none"
          />
        </div>

        <Button onClick={() => setDialogOpen(true)} disabled={!native}>
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          New patient
        </Button>
      </div>



      {error && (
        <Card className="border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">
          {error}
        </Card>
      )}

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <SortHeader label="Name" column="name" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Gender" column="gender" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Age" column="age" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Sessions" column="sessions" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Mean score" column="score" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Last active" column="lastActive" active={sortKey} descending={descending} onSort={onSort} />
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((patient) => (
              <TableRow key={patient.id}>
                <TableCell>
                  <button
                    type="button"
                    onClick={() => onSelectPatient(patient)}
                    className="text-left font-medium text-brand-400 hover:underline"
                  >
                    {patient.name}
                  </button>
                </TableCell>
                <TableCell className="text-slate-400">{patient.gender || "—"}</TableCell>
                <TableCell className="text-slate-400">{patient.age || "—"}</TableCell>
                <TableCell className="text-slate-400">{patient.total_sessions ?? 0}</TableCell>
                <TableCell className="text-slate-400">
                  {patient.lifetime_avg_score != null
                    ? `${patient.lifetime_avg_score.toFixed(1)}%`
                    : "—"}
                </TableCell>
                <TableCell className="text-slate-400">
                  {patient.last_active ? formatDate(patient.last_active) : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <button
                    type="button"
                    onClick={() => void remove(patient)}
                    aria-label={`Delete ${patient.name}`}
                    className="rounded-control p-1.5 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </TableCell>
              </TableRow>
            ))}

            {loading && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center">
                  <span className="inline-flex items-center gap-2 text-sm text-slate-500">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-700 border-t-brand-400" />
                    Loading patients…
                  </span>
                </TableCell>
              </TableRow>
            )}

            {!loading && sorted.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-sm text-slate-500">
                  {patients.length === 0
                    ? "No patients yet. Create the first record to begin a session."
                    : `No patients match “${query}”.`}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="New patient"
        description="Clinical demographics are stored locally and synced to Firestore."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} loading={saving}>
              Save patient
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Full name</span>
            <input
              data-autofocus
              type="text"
              value={form.name}
              onChange={(event) =>
                setForm((current) => ({ ...current, name: event.target.value }))
              }
              className={FIELD_CLASSES}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Age (years)</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={form.age ?? ""}
              onChange={(event) =>
                setForm((current) => ({ ...current, age: sanitizeInteger(event.target.value) }))
              }
              className={FIELD_CLASSES}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Weight (kg)</span>
            <input
              type="text"
              inputMode="decimal"
              value={form.weight ?? ""}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  weight: sanitizeDecimal(event.target.value),
                }))
              }
              className={FIELD_CLASSES}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Height (cm)</span>
            <input
              type="text"
              inputMode="decimal"
              value={form.height ?? ""}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  height: sanitizeDecimal(event.target.value),
                }))
              }
              className={FIELD_CLASSES}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Gender</span>
            <select
              value={form.gender ?? "Female"}
              onChange={(event) =>
                setForm((current) => ({ ...current, gender: event.target.value }))
              }
              className={FIELD_CLASSES}
            >
              {GENDERS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Dialog>
    </div>
  );
}
