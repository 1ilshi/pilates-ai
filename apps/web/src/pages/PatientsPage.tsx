import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Input,
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
  formatPercent,
} from "@pilates/ui";
import { listenPatients, type PortalPatient } from "../lib/data";
import { formatDate } from "../lib/legacy";

type SortKey = "name" | "gender" | "age" | "sessions" | "score" | "lastActive";
type PageSize = "10" | "25" | "50" | "all";

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
            ? "inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-primary"
            : "inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>("10");

  // A new search or sort starts from the first page; the result set changed.
  useEffect(() => {
    setPage(1);
  }, [query, sortKey, descending, pageSize]);

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

  const rowsPerPage = pageSize === "all" ? Math.max(sorted.length, 1) : Number(pageSize);
  const pageCount = Math.max(1, Math.ceil(sorted.length / rowsPerPage));
  const currentPage = Math.min(page, pageCount);
  const start = sorted.length === 0 ? 0 : (currentPage - 1) * rowsPerPage + 1;
  const end = Math.min(sorted.length, currentPage * rowsPerPage);
  const visible = sorted.slice((currentPage - 1) * rowsPerPage, currentPage * rowsPerPage);

  const historyBadge = (patient: PortalPatient) => {
    if (patient.totalSessions > 0) {
      return <Badge variant="success" dot>Current</Badge>;
    }
    if (patient.legacy) {
      return <Badge variant="warning" dot>Legacy</Badge>;
    }
    return <Badge variant="secondary" dot>None</Badge>;
  };

  const pagination = (compact = false) => (
    <div className={compact ? "flex items-center justify-between gap-2" : "flex flex-wrap items-center justify-between gap-3"}>
      <p className="text-xs text-muted-foreground">
        Showing <span className="font-mono text-foreground/85">{start}</span>–
        <span className="font-mono text-foreground/85">{end}</span> of{" "}
        <span className="font-mono text-foreground/85">{sorted.length}</span>
      </p>
      <div className="flex items-center gap-2">
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
              <span key={`gap-${index}`} className="hidden px-1 text-xs text-muted-foreground sm:inline">…</span>
            ) : (
              <Button
                key={item}
                variant={item === currentPage ? "secondary" : "ghost"}
                size="icon-sm"
                className="hidden text-xs sm:inline-flex"
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
        {!compact && (
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground lg:inline">Rows per page</span>
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
        )}
      </div>
    </div>
  );

  const searchInput = (
    <div className="relative w-full max-w-sm">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by name…"
        aria-label="Search patients"
        className="h-9 bg-card/70 pl-9"
      />
    </div>
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">Patients</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {loading ? "Loading…" : `${patients.length} record(s)`}
        </p>
      </div>

      {error && (
        <Card className="border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">{error}</Card>
      )}

      {/* Wide screens: a single framed table with header, search and footer. */}
      <Card className="hidden gap-0 overflow-hidden py-0 sm:block">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3.5">
          <div>
            <h2 className="font-display text-base font-semibold tracking-tight text-foreground">
              Patient roster
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {patients.length} record{patients.length === 1 ? "" : "s"}
              {query && ` · ${filtered.length} matching “${query}”`}
            </p>
          </div>
          <Badge variant="secondary" dot className="bg-primary/10 text-primary">Live</Badge>
        </div>

        <div className="border-b border-border/60 bg-background/25 px-5 py-3">
          {searchInput}
        </div>

        <Table containerClassName="warm-scrollbar" className="min-w-[820px]">
          <TableHeader className="bg-muted/20 [&_tr]:border-border/50">
            <TableRow className="hover:bg-transparent">
              <SortHeader label="Name" column="name" active={sortKey} descending={descending} onSort={onSort} className="pl-4 sm:pl-5" />
              <SortHeader label="Gender" column="gender" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Age" column="age" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Sessions" column="sessions" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Mean accuracy" column="score" active={sortKey} descending={descending} onSort={onSort} />
              <SortHeader label="Last active" column="lastActive" active={sortKey} descending={descending} onSort={onSort} />
              <TableHead className="w-28 pr-4 sm:pr-5">History</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr:last-child]:border-0">
            {visible.map((patient) => (
              <TableRow key={patient.id} className="border-border/40 hover:bg-primary/[0.05]">
                <TableCell className="py-2.5 pl-4 sm:pl-5">
                  <Link
                    to={`/patients/${patient.id}`}
                    state={{ from: "Patients" }}
                    className="font-medium text-primary hover:underline"
                  >
                    {patient.name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{patient.gender || "—"}</TableCell>
                <TableCell className="font-mono text-[13px] text-muted-foreground">{patient.age || "—"}</TableCell>
                <TableCell className="font-mono text-[13px] text-muted-foreground">{patient.totalSessions}</TableCell>
                <TableCell><AccuracyMeter value={patient.lifetimeAvgScore} /></TableCell>
                <TableCell className="text-muted-foreground">{formatDate(patient.lastActive)}</TableCell>
                <TableCell className="pr-4 sm:pr-5">{historyBadge(patient)}</TableCell>
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

            {filtered.length === 0 && !loading && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                  {patients.length === 0
                    ? "No patients found in Firestore."
                    : `No patients match “${query}”.`}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <div className="border-t border-border/60 bg-background/25 px-5 py-3">
          {pagination()}
        </div>
      </Card>

      {/* Phones: one card per patient. Seven columns cannot be squeezed into
          390px without becoming unreadable. */}
      <div className="space-y-3 sm:hidden">
        <Card className="gap-0 overflow-hidden py-0">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
            <div>
              <h2 className="font-display text-sm font-semibold tracking-tight">Patient roster</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {patients.length} record{patients.length === 1 ? "" : "s"}
              </p>
            </div>
            <Badge variant="secondary" dot className="bg-primary/10 text-primary">Live</Badge>
          </div>
          <div className="border-b border-border/60 bg-background/25 px-4 py-3">
            {searchInput}
          </div>
        </Card>

        {loading && (
          <Card className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
            <span className="size-3.5 animate-spin rounded-full border-2 border-border border-t-primary" />
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

        {visible.map((patient) => (
          <Link
            key={patient.id}
            to={`/patients/${patient.id}`}
            state={{ from: "Patients" }}
            className="group block overflow-hidden rounded-card border border-border/70 bg-card shadow-card transition-colors hover:border-primary/30 active:bg-accent/60"
          >
            <div className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-primary group-hover:underline">
                  {patient.name}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {patient.gender || "—"} · {patient.age ? `${patient.age} yrs` : "—"} · {patient.totalSessions} sessions
                </p>
              </div>
              {historyBadge(patient)}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/50 bg-background/25 px-4 py-3 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Accuracy</dt>
                <dd className="font-mono text-foreground/85">
                  {patient.lifetimeAvgScore != null ? formatPercent(patient.lifetimeAvgScore) : "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Last active</dt>
                <dd className="text-foreground/85">
                  {patient.lastActive ? formatDate(patient.lastActive) : "—"}
                </dd>
              </div>
            </dl>
            <div className="border-t border-border/50 px-4 py-2.5">
              <AccuracyMeter value={patient.lifetimeAvgScore} />
            </div>
          </Link>
        ))}

        <Card className="gap-0 py-0">
          <div className="px-4 py-3">{pagination(true)}</div>
        </Card>
      </div>
    </div>
  );
}
