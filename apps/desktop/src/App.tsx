import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { BarChart3, Camera, ExternalLink, LogOut, Users } from "lucide-react";
import type { ClinicalSessionDocument } from "@pilates/types";
import { poseDisplayLabel } from "@pilates/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  cn,
  Toaster,
} from "@pilates/ui";
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
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  // Escape closes the confirmation, matching the portal's dialogs.
  useEffect(() => {
    if (!confirmSignOut) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmSignOut(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmSignOut]);

  const openAnalysis = () => {
    // Clear first, so a successful retry does not leave a stale warning.
    setPortalError(null);
    openPortal().catch((error) => setPortalError(String(error)));
  };

  // Shared laptop: hand the workstation to the next person. Blocked during a
  // recording, where losing the credential would strand the session.
  const signOut = () => {
    authSignOut()
      .then(() => {
        setConfirmSignOut(false);
        setAccess("required");
      })
      .catch((error) => {
        setConfirmSignOut(false);
        setPortalError(String(error));
      });
  };

  // A `PERMISSION_DENIED` from Firestore means this account cannot reach the
  // clinic data — a disabled account or rules that still expect a claim.
  // "Sync failed" would leave the clinic guessing.
  const notProvisioned =
    !!sync.lastError && /permission_denied|403|insufficient permissions/i.test(sync.lastError);
  const notConfigured =
    !!sync.lastError && /not configured/i.test(sync.lastError);
  const syncError = sync.lastError?.replace(/^auth:\s*/i, "") ?? null;

  const syncLabel = sync.syncing
    ? "Syncing…"
    : sync.lastError === "offline"
      ? "Offline — queued locally"
      : sync.authRejected
        ? "Sign in to resume syncing"
        : notProvisioned
          ? "Account cannot access this clinic"
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
    "inline-flex items-center gap-2 rounded-full border border-transparent px-3 py-1.5 text-sm font-medium transition-colors";
  const navActive = "bg-primary/10 text-primary";
  const navIdle =
    "text-muted-foreground hover:bg-accent hover:text-foreground";

  if (access === "checking") {
    return (
      <div className="flex h-screen w-screen items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
        Starting…
      </div>
    );
  }

  if (access === "required") {
    return (
      <AccessGate
        onSignedIn={() => {
          setAccess("ready");
          // Clear the "sign in to resume syncing" banner as soon as the new
          // credential is used, instead of waiting for the next sweep.
          window.dispatchEvent(new Event("pilates:sync-now"));
        }}
      />
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-background font-sans text-foreground">
      {/* Top bar — brand and destinations on one line. */}
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-sidebar-border bg-sidebar px-4">
        <div className="flex shrink-0 items-center gap-2.5">
          <Logo className="h-8 w-8 shrink-0" />
          <div className="hidden leading-tight lg:block">
            <h1 className="font-display text-sm font-semibold tracking-tight text-foreground">
              Pilates AI
            </h1>
            <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
              Clinical workstation
            </p>
          </div>
        </div>

        <nav className="flex min-w-0 items-center gap-1" aria-label="Main navigation">
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
              className="h-3 w-3 text-muted-foreground/60"
              aria-hidden="true"
            />
          </button>
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {patient && (
            <span
              className="hidden max-w-40 truncate rounded-full bg-sidebar-accent px-2.5 py-1 text-xs text-foreground md:inline"
              title={`Active patient: ${patient.name}`}
            >
              {patient.name}
            </span>
          )}
          <span
            className="hidden text-[11px] text-muted-foreground 2xl:inline"
            title={syncError ?? undefined}
          >
            {syncLabel}
          </span>
          <Badge variant={isTauri() ? "success" : "warning"} dot>
            {isTauri() ? "Engine Ready" : "Browser Mode"}
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setConfirmSignOut(true)}
            disabled={tab === "capture"}
            title={
              tab === "capture"
                ? "Finish the recording before signing out"
                : "Sign out of this workstation"
            }
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </header>

      {/* Context strip: the current destination or record, plus sync details. */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
        <h2 className="truncate font-display text-base font-semibold tracking-tight text-foreground">
          {heading}
        </h2>
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
          <span className="hidden md:inline">
            Tauri 2.0 · Rust Engine v{appVersion ?? "…"}
          </span>
          <button
            type="button"
            onClick={() => void update.checkNow()}
            disabled={update.checking || tab === "capture"}
            title={update.error ?? "Check the release channel for a newer build"}
            className="text-[11px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {update.checking
              ? "Checking for updates…"
              : update.upToDate
                ? "Up to date"
                : "Check for updates"}
          </button>
        </div>
      </div>

      {(syncError || portalError) && (
        <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-b border-amber-500/30 bg-amber-500/10 px-6 py-1.5 text-[11px] text-amber-300">
          {syncError && syncError !== "offline" && (
            <span title={syncError}>{syncError}</span>
          )}
          {portalError && (
            <span title={portalError}>Could not open portal — {portalError}</span>
          )}
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Never prompt while a session could be recording. */}
        {tab !== "capture" && <UpdateBanner update={update} />}

        {sync.authRejected && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-200">
            <span>
              Sync is paused — this workstation&apos;s sign-in was rejected. You
              can keep recording; sessions will upload once you sign in again.
            </span>
            <button
              type="button"
              onClick={() => setAccess("required")}
              className="rounded-full border border-amber-500/40 px-2.5 py-1 font-medium hover:bg-amber-500/20"
            >
              Sign in
            </button>
          </div>
        )}

        <section
          className={cn(
            "min-h-0 flex-1 overflow-y-auto p-6",
            tab === "capture" && "overflow-hidden p-3",
          )}
        >
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

      {confirmSignOut && (
        <AlertDialog open onOpenChange={(next) => !next && setConfirmSignOut(false)}>
          <AlertDialogContent onOutsideDismiss={() => setConfirmSignOut(false)}>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Sign out of this workstation?
              </AlertDialogTitle>
              <AlertDialogDescription>
                You will need your email and password to sign in again.
                Sessions already recorded stay on this machine and upload
                after you sign in.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={signOut}
                className="bg-destructive text-white hover:bg-destructive/90"
              >
                Sign out
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      <Toaster position="bottom-right" />
    </div>
  );
}

export default App;
