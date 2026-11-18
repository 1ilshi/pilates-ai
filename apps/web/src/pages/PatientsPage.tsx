import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import {
  Badge,
  Card,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatPercent,
} from "@pilates/ui";
import { listenPatients, type PortalPatient } from "../lib/data";
import { formatDate } from "../lib/legacy";

type SortKey = "name" | "gender" | "age" | "sessions" | "score" | "lastActive";

/** Click a column once to sort ascending, again to reverse. */
function SortHeader({
  label,
  column,
  active,
  descending,
  onSort,
}: {
  label: string;
  column: SortKey;
  active: SortKey;
  descending: boolean;
  onSort: (column: SortKey) => void;
}) {
  const isActive = active === column;
  return (
    <TableHead>
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
        <span className="text-[9px]">
          {isActive ? (descending ? "\u25bc" : "\u25b2") : "\u2195"}
        </span>
      </button>
    </TableHead>
  );
}

export function PatientsPage() {
  const [patients, setPatients] = useState<PortalPatient[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Live: a patient added or edited on a workstation appears here without a
    // reload, which is the whole point of a shared roster.
    const stop = listenPatients(
      (rows) => {
        if (cancelled) return;
        setPatients(rows);
        setLoading(false);
      },
      (caught) => {
        if (cancelled) return;
        setError(String(caught));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);

  const onSort = (column: SortKey) => {
    if (column === sortKey) {
      setDescending((current) => !current);
    } else {
      setSortKey(column);
      setDescending(false);
    }
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return patients;
    return patients.filter(
      (patient) =>
        patient.name.toLowerCase().includes(needle) ||
        patient.gender.toLowerCase().includes(needle),
    );
  }, [patients, query]);

  const sorted = useMemo(() => {
    const value = (patient: (typeof patients)[number]): string | number => {
      switch (sortKey) {
        case "gender":
          return (patient.gender ?? "").toLowerCase();
        case "age":
          return Number.parseFloat(patient.age ?? "") || 0;
        case "sessions":
          return patient.totalSessions ?? 0;
        case "score":
          return patient.lifetimeAvgScore ?? -1;
        case "lastActive":
          return Date.parse(patient.lastActive ?? "") || 0;
        default:
          return patient.name.toLowerCase();
      }
    };
    const rows = [...filtered].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      if (typeof left === "number" && typeof right === "number") return left - right;
      return String(left).localeCompare(String(right));
    });
    return descending ? rows.reverse() : rows;
  }, [filtered, sortKey, descending]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">Patients</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {loading ? "Loading…" : `${patients.length} record(s)`}
        </p>
      </div>

      {error && (
        <Card className="border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">{error}</Card>
      )}

      <div className="relative max-w-md">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name…"
          aria-label="Search patients"
          className="pl-9"
        />
      </div>

      <Card className="hidden sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHeader label="Name" column="name" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Gender" column="gender" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Age" column="age" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Sessions" column="sessions" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Mean accuracy" column="score" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Last active" column="lastActive" active={sortKey} descending={descending} onSort={onSort} />
              <TableHead>History</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((patient) => (
              <TableRow key={patient.id}>
                <TableCell>
                  <Link
                    to={`/patients/${patient.id}`}
                    state={{ from: "Patients" }}
                    className="font-medium text-primary hover:underline"
                  >
                    {patient.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{patient.gender || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{patient.age || "—"}</TableCell>
                <TableCell className="text-muted-foreground">{patient.totalSessions}</TableCell>
                <TableCell>
                  {patient.lifetimeAvgScore != null
                    ? formatPercent(patient.lifetimeAvgScore)
                    : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDate(patient.lastActive)}</TableCell>
                <TableCell>
                  <div className="flex gap-1.5">
                    {patient.totalSessions > 0 && <Badge variant="default">Current</Badge>}
                    {patient.legacy && <Badge variant="warning">Legacy</Badge>}
                    {patient.totalSessions === 0 && !patient.legacy && (
                      <Badge variant="secondary">None</Badge>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {loading && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center">
                  <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-primary" />
                    Loading patients…
                  </span>
                </TableCell>
              </TableRow>
            )}

            {filtered.length === 0 && !loading && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                  {patients.length === 0
                    ? "No patients found in Firestore."
                    : `No patients match “${query}”.`}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Phones: one card per patient. Seven columns cannot be squeezed into
          390px without becoming unreadable. */}
      <div className="space-y-2 sm:hidden">
        {loading && (
          <Card className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-primary" />
            Loading patients…
          </Card>
        )}

        {!loading && sorted.length === 0 && (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            {patients.length === 0
              ? "No patients found in Firestore."
              : `No patients match “${query}”.`}
          </Card>
        )}

        {sorted.map((patient) => (
          <Link
            key={patient.id}
            to={`/patients/${patient.id}`}
            state={{ from: "Patients" }}
            className="block rounded-card border border-border bg-card/40 p-3 active:bg-accent/60"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="truncate text-sm font-semibold text-primary">
                {patient.name}
              </p>
              <div className="flex shrink-0 gap-1">
                {patient.totalSessions > 0 && <Badge variant="default">Current</Badge>}
                {patient.legacy && <Badge variant="warning">Legacy</Badge>}
                {patient.totalSessions === 0 && !patient.legacy && (
                  <Badge variant="secondary">None</Badge>
                )}
              </div>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Gender</dt>
                <dd className="text-foreground/80">{patient.gender || "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Age</dt>
                <dd className="text-foreground/80">{patient.age || "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Sessions</dt>
                <dd className="text-foreground/80">{patient.totalSessions}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Accuracy</dt>
                <dd className="text-foreground/80">
                  {patient.lifetimeAvgScore != null
                    ? formatPercent(patient.lifetimeAvgScore)
                    : "—"}
                </dd>
              </div>
              <div className="col-span-2 flex justify-between gap-2">
                <dt className="text-muted-foreground">Last active</dt>
                <dd className="text-foreground/80">
                  {patient.lastActive ? formatDate(patient.lastActive) : "—"}
                </dd>
              </div>
            </dl>
          </Link>
        ))}
      </div>
    </div>
  );
}
