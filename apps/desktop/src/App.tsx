import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { BarChart3, Camera, ExternalLink, LogOut, Users } from "lucide-react";
import type { ClinicalSessionDocument } from "@pilates/types";
import { poseDisplayLabel } from "@pilates/types";
import { Badge, cn } from "@pilates/ui";
import { PatientListPage } from "./pages/PatientListPage";
import { PatientDetailPage } from "./pages/PatientDetailPage";
import { ActiveCapturePage } from "./pages/ActiveCapturePage";
import { SessionDetailPage } from "./pages/SessionDetailPage";
import { Logo } from "./components/Logo";
import { UpdateBanner } from "./components/UpdateBanner";
import { AccessGate } from "./components/AccessGate";
import { authSignOut, isTauri, openPortal, pairingStatus, type PatientRecord } from "./lib/ipc";
import { useAutoSync } from "./hooks/useAutoSync";
import { useUpdate } from "./hooks/useUpdate";

/**
 * `session` is deliberately not in the navigation: a session is opened from a
 * patient's history, not browsed as a top-level destination.
 */
type Tab = "capture" | "patients" | "patient" | "session";

/** Short "2m ago" style label for the sync indicator. */
function relativeTime(from: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - from) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

const NAV: Array<{ id: Tab; label: string; icon: typeof Camera }> = [
  { id: "capture", label: "Pose Capture", icon: Camera },
  { id: "patients", label: "Patients", icon: Users },
];

interface View {
  tab: Tab;
  patient: PatientRecord | null;
  session: ClinicalSessionDocument | null;
}

const TAB_LABELS: Record<Tab, string> = {
  capture: "Pose Capture",
  patients: "Patients",
  patient: "Patient",
  session: "Session",
};

export function App() {
  const [view, setView] = useState<View>({
    tab: "patients",
    patient: null,
    session: null,
  });
  // Every navigation pushes the view it left, so "back" returns to wherever
  // the user actually came from instead of a hardcoded destination.
  const [history, setHistory] = useState<View[]>([]);
  // `checking` avoids flashing the gate before the credential is read.
  const [access, setAccess] = useState<"checking" | "required" | "ready">(
    "checking",
  );
  const { tab, patient, session } = view;

  useEffect(() => {
    let cancelled = false;
    pairingStatus()
      .then((status) => {
        if (!cancelled) setAccess(status.paired ? "ready" : "required");
      })
      .catch(() => {
        // Never block the app on a status failure: an unreadable status file is
        // not a reason to deny a clinician access to local records.
        if (!cancelled) setAccess("ready");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The version comes from the bundle, not from a literal: a hardcoded string
  // kept reporting 2.0.0 after an update, which made a successful update look
  // like it had not happened.
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(null));
  }, []);

  const navigate = (next: Partial<View>) => {
    setHistory((current) => [...current, view]);
    setView((current) => ({ ...current, ...next }));
  };

  const goBack = () => {
    if (history.length === 0) {
      setView((current) => ({ ...current, tab: "patients", session: null }));
      return;
    }
    setView(history[history.length - 1]);
    setHistory((current) => current.slice(0, -1));
  };

  const backTarget = history.length > 0 ? history[history.length - 1] : null;
  const backLabel = backTarget
    ? backTarget.tab === "patient"
      ? (backTarget.patient?.name ?? "Patient")
      : TAB_LABELS[backTarget.tab]
    : "Patients";

  // Push queued sessions and refresh the roster whenever the network allows.
  const sync = useAutoSync();

  // Check-only update prompt; suppressed while the capture tab is open so a
  // restart can never interrupt a recording.
  const update = useUpdate(isTauri() && tab !== "capture");

  // Opening the portal is best-effort: the browser may be missing or blocked.
  // Without this the Analysis button would fail silently, so the reason is
  // surfaced in the footer next to the sync status instead of a new toast.
  const [portalError, setPortalError] = useState<string | null>(null);

  const openAnalysis = () => {
    // Clear first, so a successful retry does not leave a stale warning.
    setPortalError(null);
    openPortal().catch((error) => setPortalError(String(error)));
  };

  // Shared laptop: hand the workstation to the next person. Blocked during a
  // recording, where losing the credential would strand the session.
  const signOut = () => {
    authSignOut()
      .then(() => setAccess("required"))
      .catch((error) => setPortalError(String(error)));
  };

  // A `PERMISSION_DENIED` from Firestore almost always means the account is
  // missing the `clinic` custom claim, which an administrator has to set with
  // `pnpm claim:clinic`. "Sync failed" would leave the clinic guessing.
  const notProvisioned =
    !!sync.lastError && /permission_denied|403|insufficient permissions/i.test(sync.lastError);
  const notConfigured =
    !!sync.lastError && /not configured/i.test(sync.lastError);

  const syncLabel = sync.syncing
    ? "Syncing…"
    : sync.lastError === "offline"
      ? "Offline — queued locally"
      : notProvisioned
        ? "Account not provisioned for this clinic"
        : notConfigured
          ? // Retrying will not help: there is no cloud configuration to use.
            "Cloud sync off — not configured"
          : sync.lastError
            ? "Sync failed — retrying"
            : sync.lastSyncAt
              ? `Synced ${relativeTime(sync.lastSyncAt)}`
              : "Not synced yet";

  const heading =
    tab === "patient"
      ? (patient?.name ?? "Patient")
      : tab === "session"
        ? poseDisplayLabel(session?.pose_id)
        : NAV.find((entry) => entry.id === tab)?.label;

  const navItem =
    "flex w-full items-center gap-3 rounded-control border px-3 py-2 text-sm font-medium transition-colors";
  const navActive = "border-brand-500/20 bg-brand-500/10 text-brand-400";
  const navIdle =
    "border-transparent text-slate-400 hover:bg-slate-800 hover:text-slate-200";

  if (access === "checking") {
    return (
      <div className="flex h-screen w-screen items-center justify-center gap-2 bg-slate-950 text-sm text-slate-500">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-700 border-t-brand-400" />
        Starting…
      </div>
    );
  }

  if (access === "required") {
    return <AccessGate onSignedIn={() => setAccess("ready")} />;
  }

  return (
    <div className="flex h-screen w-screen bg-slate-950 font-sans text-slate-100">
      <aside className="flex w-60 shrink-0 flex-col justify-between border-r border-slate-800 bg-slate-900/50 p-4">
        <div>
          <div className="mb-8 flex items-center gap-2.5 px-2">
            <Logo className="h-9 w-9 shrink-0" />
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold leading-tight tracking-tight text-white">
                Pilates AI
              </h1>
              <p className="text-[10px] uppercase tracking-wider text-slate-500">
                Clinical workstation
              </p>
            </div>
          </div>

          <nav className="space-y-1" aria-label="Main navigation">
            {NAV.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => navigate({ tab: id, session: null })}
                aria-current={tab === id ? "page" : undefined}
                className={cn(navItem, tab === id ? navActive : navIdle)}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {label}
              </button>
            ))}

            {/*
              Analysis lives in the cloud portal, not here: it is a cohort-level
              view that benefits from shared, always-current data.
            */}
            <button
              type="button"
              onClick={openAnalysis}
              title="Opens the clinical portal in your browser"
              className={cn(navItem, navIdle)}
            >
              <BarChart3 className="h-4 w-4" aria-hidden="true" />
              Analysis
              <ExternalLink
                className="ml-auto h-3 w-3 text-slate-600"
                aria-hidden="true"
              />
            </button>
          </nav>

          {patient && (
            <div className="mt-6 rounded-control border border-slate-800 bg-slate-900/60 p-3">
              <p className="text-xs text-slate-500">Active patient</p>
              <p className="truncate text-sm font-medium text-slate-200">{patient.name}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {patient.gender || "—"} · {patient.age || "—"}
              </p>
            </div>
          )}
        </div>

        <div className="px-2 text-xs text-slate-500">
          <p
            title={sync.lastError ?? undefined}
            className={
              sync.lastError && sync.lastError !== "offline"
                ? "text-amber-400"
                : "text-slate-400"
            }
          >
            {syncLabel}
          </p>
          {sync.lastError && sync.lastError !== "offline" && (
            <p
              className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-amber-500/80"
              title={sync.lastError}
            >
              {sync.lastError}
            </p>
          )}
          {portalError && (
            <p
              className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-amber-500/80"
              title={portalError}
            >
              Could not open portal — {portalError}
            </p>
          )}
          <p className="mt-0.5">
            Tauri 2.0 · Rust Engine v{appVersion ?? "…"}
          </p>
          <button
            type="button"
            onClick={signOut}
            disabled={tab === "capture"}
            title={
              tab === "capture"
                ? "Finish the recording before signing out"
                : "Sign out and return to the sign-in screen"
            }
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-control border border-slate-700 px-2 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-800 px-6">
          <h2 className="text-base font-semibold text-slate-200">{heading}</h2>
          <Badge variant={isTauri() ? "success" : "warning"} dot>
            {isTauri() ? "Engine Ready" : "Browser Mode"}
          </Badge>
        </header>

        {/* Never prompt while a session could be recording. */}
        <UpdateBanner update={update} />

        {sync.lastError && /token refresh rejected|credential|401/i.test(sync.lastError) && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-200">
            <span>
              Sync is paused — the account on this workstation was rejected. You
              can keep recording; sessions will upload once you sign in again.
            </span>
            <button
              type="button"
              onClick={() => setAccess("required")}
              className="rounded-control border border-amber-500/40 px-2 py-1 font-medium hover:bg-amber-500/20"
            >
              Sign in
            </button>
          </div>
        )}

        <section className="flex-1 overflow-y-auto p-6">
          {tab === "patients" && (
            <PatientListPage
              onSelectPatient={(selected) =>
                navigate({ patient: selected, tab: "patient" })
              }
              onPatientDeleted={(id) =>
                setView((current) => ({
                  ...current,
                  patient: current.patient?.id === id ? null : current.patient,
                  // The detail page would otherwise render with no patient.
                  tab: current.tab === "patient" ? "patients" : current.tab,
                }))
              }
            />
          )}

          {tab === "patient" && patient && (
            <PatientDetailPage
              patient={patient}
              onBack={goBack}
              onPatientSaved={(updated) =>
                setView((current) => ({ ...current, patient: updated }))
              }
              backLabel={backLabel}
              onStartSession={() => navigate({ tab: "capture" })}
              onOpenSession={(document) =>
                navigate({ session: document, tab: "session" })
              }
            />
          )}

          {tab === "capture" && (
            <ActiveCapturePage
              patient={patient}
              onSessionComplete={(document) =>
                navigate({
                  session: document as unknown as ClinicalSessionDocument,
                  tab: "session",
                })
              }
            />
          )}

          {tab === "session" && (
            <SessionDetailPage
              document={session}
              onBack={goBack}
              backLabel={backLabel}
              onNewSession={() => navigate({ tab: "capture" })}
            />
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
