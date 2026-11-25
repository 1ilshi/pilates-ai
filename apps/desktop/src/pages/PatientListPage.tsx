import { useCallback, useEffect, useMemo, useState } from "react";
import { signalSync } from "../lib/syncSignal";
import { ChevronLeft, ChevronRight, Search, UserPlus, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
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

/** Inline form-score meter — the numeric column reads at a glance. */
function AccuracyMeter({ value }: { value: number | null | undefined }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const percent = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-2.5" aria-label={`Mean accuracy ${percent.toFixed(1)} percent`}>
      <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-secondary sm:w-20">
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <span className="font-mono text-xs tabular-nums text-foreground/85">
        {percent.toFixed(1)}%
      </span>
    </div>
  );
}

/** Page buttons with ellipses for large rosters. */
function pageList(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const visible = [1, total, current - 1, current, current + 1]
    .filter((page) => page >= 1 && page <= total)
    .sort((a, b) => a - b);
  const result: (number | "…")[] = [];
  visible.forEach((page, index) => {
    if (index > 0 && page - visible[index - 1] > 1) result.push("…");
    result.push(page);
  });
  return result;
}

const EMPTY_FORM: PatientInput = {
  name: "",
  age: "",
  weight: "",
  height: "",
  gender: "Female",
};

const GENDERS = ["Female", "Male"] as const;

type PageSize = "10" | "25" | "50" | "all";

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
            ? "inline-flex items-center gap-1 font-semibold text-primary"
            : "inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        }
      >
        {label}
        <span className={`text-[9px] ${isActive ? "opacity-100" : "opacity-50"}`}>
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
  // A deletion needs its own deliberate approval — the record holds clinical
  // history, and a misclick used to hide it with no confirmation at all.
  const [patientToDelete, setPatientToDelete] = useState<PatientRecord | null>(
    null,
  );
  const [form, setForm] = useState<PatientInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>("10");
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

  // Escape closes the confirmation, matching the workstation's other dialogs.
  useEffect(() => {
    if (!patientToDelete) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPatientToDelete(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [patientToDelete]);

  // A new search or sort starts from the first page; the result set changed.
  useEffect(() => {
    setPage(1);
  }, [query, sortKey, descending, pageSize]);

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

  const rowsPerPage = pageSize === "all" ? Math.max(sorted.length, 1) : Number(pageSize);
  const pageCount = Math.max(1, Math.ceil(sorted.length / rowsPerPage));
  const currentPage = Math.min(page, pageCount);
  const start = sorted.length === 0 ? 0 : (currentPage - 1) * rowsPerPage + 1;
  const end = Math.min(sorted.length, currentPage * rowsPerPage);
  const visible = sorted.slice((currentPage - 1) * rowsPerPage, currentPage * rowsPerPage);

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

  // Only the explicit action in the confirmation dialog reaches `remove`.
  const confirmDelete = () => {
    const target = patientToDelete;
    setPatientToDelete(null);
    if (target) void remove(target);
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      {!native && (
        <Card className="border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-300">
          Running in a browser: the native engine is unavailable. Launch with{" "}
          <code className="rounded bg-secondary px-1">pnpm tauri dev</code> to load
          patients.
        </Card>
      )}

      {error && (
        <Card className="border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">
          {error}
        </Card>
      )}

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2 className="font-display text-base font-semibold tracking-tight text-foreground">
              Patient roster
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {patients.length} patient{patients.length === 1 ? "" : "s"}
              {query && ` · ${filtered.length} matching “${query}”`}
            </p>
          </div>
          <Button onClick={() => setDialogOpen(true)} disabled={!native} size="sm">
            <UserPlus className="size-4" aria-hidden="true" />
            New patient
          </Button>
        </div>

        <div className="border-b border-border/60 bg-background/25 px-4 py-3 sm:px-5">
          <div className="relative w-full max-w-sm">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search patients by name…"
              aria-label="Search patients"
              className="h-9 bg-card/70 pl-9"
            />
          </div>
        </div>

        <Table containerClassName="warm-scrollbar" className="min-w-[780px]">
          <TableHeader className="bg-muted/20 [&_tr]:border-border/50">
            <TableRow className="hover:bg-transparent">
              <SortHeader label="Name" column="name" active={sortKey} descending={descending} onSort={onSort} className="w-[26%] pl-4 sm:pl-5" />
              <SortHeader label="Gender" column="gender" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Age" column="age" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Sessions" column="sessions" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Mean accuracy" column="score" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Last active" column="lastActive" active={sortKey} descending={descending} onSort={onSort} />
              <TableHead className="w-16 pr-4 text-right sm:pr-5">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr:last-child]:border-0">
            {visible.map((patient) => (
              <TableRow key={patient.id} className="border-border/40 hover:bg-primary/[0.05]">
                <TableCell className="py-2.5 pl-4 sm:pl-5">
                  <button
                    type="button"
                    onClick={() => onSelectPatient(patient)}
                    className="text-left font-medium text-primary hover:underline"
                  >
                    {patient.name}
                  </button>
                </TableCell>
                <TableCell className="text-muted-foreground">{patient.gender || "—"}</TableCell>
                <TableCell className="font-mono text-[13px] text-muted-foreground">{patient.age || "—"}</TableCell>
                <TableCell className="font-mono text-[13px] text-muted-foreground">{patient.total_sessions ?? 0}</TableCell>
                <TableCell><AccuracyMeter value={patient.lifetime_avg_score} /></TableCell>
                <TableCell className="text-muted-foreground">
                  {patient.last_active ? formatDate(patient.last_active) : "—"}
                </TableCell>
                <TableCell className="pr-4 text-right sm:pr-5">
                  <button
                    type="button"
                    onClick={() => setPatientToDelete(patient)}
                    aria-label={`Delete ${patient.name}`}
                    className="inline-flex size-8 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-red-500/10 hover:text-red-400"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                </TableCell>
              </TableRow>
            ))}

            {loading && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="py-10 text-center">
                  <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="size-3.5 animate-spin rounded-full border-2 border-border border-t-primary" />
                    Loading patients…
                  </span>
                </TableCell>
              </TableRow>
            )}

            {!loading && sorted.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                  {patients.length === 0
                    ? "No patients yet. Create the first record to begin a session."
                    : `No patients match “${query}”.`}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-background/25 px-4 py-3 sm:px-5">
          <p className="text-xs text-muted-foreground">
            Showing <span className="font-mono text-foreground/85">{start}</span>–
            <span className="font-mono text-foreground/85">{end}</span> of{" "}
            <span className="font-mono text-foreground/85">{sorted.length}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={currentPage === 1}
                aria-label="Previous page"
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </Button>
              {pageList(currentPage, pageCount).map((item, index) =>
                item === "…" ? (
                  <span key={`gap-${index}`} className="px-1 text-xs text-muted-foreground">…</span>
                ) : (
                  <Button
                    key={item}
                    variant={item === currentPage ? "secondary" : "ghost"}
                    size="icon-sm"
                    className="text-xs"
                    onClick={() => setPage(item)}
                    aria-label={`Page ${item}`}
                    aria-current={item === currentPage ? "page" : undefined}
                  >
                    {item}
                  </Button>
                ),
              )}
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                disabled={currentPage === pageCount}
                aria-label="Next page"
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-muted-foreground sm:inline">Rows per page</span>
              <Select value={pageSize} onValueChange={(value) => setPageSize(value as PageSize)}>
                <SelectTrigger className="h-8 w-[68px] text-xs" aria-label="Rows per page">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10</SelectItem>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="all">All</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New patient</DialogTitle>
            <DialogDescription>
              Clinical demographics are stored locally and synced to Firestore.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="new-patient-name">Full name</Label>
              <Input
                id="new-patient-name"
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="new-patient-age">Age (years)</Label>
              <Input
                id="new-patient-age"
                inputMode="numeric"
                pattern="[0-9]*"
                value={form.age ?? ""}
                onChange={(event) =>
                  setForm((current) => ({ ...current, age: sanitizeInteger(event.target.value) }))
                }
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="new-patient-weight">Weight (kg)</Label>
                <Input
                  id="new-patient-weight"
                  inputMode="decimal"
                  value={form.weight ?? ""}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      weight: sanitizeDecimal(event.target.value),
                    }))
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="new-patient-height">Height (cm)</Label>
                <Input
                  id="new-patient-height"
                  inputMode="decimal"
                  value={form.height ?? ""}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      height: sanitizeDecimal(event.target.value),
                    }))
                  }
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="new-patient-gender">Gender</Label>
              <Select
                value={form.gender ?? "Female"}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, gender: value }))
                }
              >
                <SelectTrigger id="new-patient-gender" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GENDERS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void submit()} loading={saving}>
                Save patient
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {patientToDelete && (
        <AlertDialog
          open
          onOpenChange={(next) => !next && setPatientToDelete(null)}
        >
          <AlertDialogContent onOutsideDismiss={() => setPatientToDelete(null)}>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {patientToDelete.name}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This hides the patient and their session history from the
                workstation and queues the deletion for cloud sync. The record
                is not erased, but it disappears from the list. Confirm only
                if this is the right patient.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                className="bg-destructive text-white hover:bg-destructive/90"
              >
                Delete patient
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
