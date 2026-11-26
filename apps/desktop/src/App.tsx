import { useEffect, useRef, useState } from "react";
import { BarChart3, Camera, Check, ExternalLink, LogOut, RefreshCw, Settings, Users, X } from "lucide-react";
import type { ClinicalSessionDocument } from "@pilates/types";
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
  cn,
  Toaster,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@pilates/ui";
import { PatientListPage } from "./pages/PatientListPage";
import { PatientDetailPage } from "./pages/PatientDetailPage";
import { ActiveCapturePage } from "./pages/ActiveCapturePage";
import { SessionDetailPage } from "./pages/SessionDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AccessGate } from "./components/AccessGate";
import {
  authSignOut,
  engineStatus,
  isTauri,
  openPortal,
  pairingStatus,
  type EngineStatus,
  type PatientRecord,
} from "./lib/ipc";
import { useAutoSync } from "./hooks/useAutoSync";
import { useUpdate } from "./hooks/useUpdate";

/**
 * `session` is deliberately not in the navigation: a session is opened from a
 * patient's history, not browsed as a top-level destination.
 */
type Tab = "capture" | "patients" | "patient" | "session" | "settings";

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
  settings: "Settings",
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

  // Analysis opens in the portal, so it cannot be derived from `tab`. Keep it
  // highlighted once opened until the clinician picks another destination.
  const [analysisActive, setAnalysisActive] = useState(false);

  const navigate = (next: Partial<View>) => {
    setAnalysisActive(false);
    setHistory((current) => [...current, view]);
    setView((current) => ({ ...current, ...next }));
  };

  const goBack = () => {
    setAnalysisActive(false);
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

  // Live engine health for the top-bar dot. The browser build has no engine at
  // all; a native build can still lose it (missing runtime/model), so poll the
  // real status instead of assuming "Tauri == ready".
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await engineStatus();
        if (!cancelled) setEngine(status);
      } catch {
        if (!cancelled) setEngine(null);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Opening the portal is best-effort: the browser may be missing or blocked.
  // Without this the Analysis button would fail silently, so the reason is
  // surfaced in the footer next to the sync status instead of a new toast.
  const [portalError, setPortalError] = useState<string | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // The auto-check offers the update once per detected version. Installing and
  // dismissing both mark it handled so the prompt cannot immediately reopen.
  const [updatePromptOpen, setUpdatePromptOpen] = useState(false);
  const promptedVersion = useRef<string | null>(null);

  useEffect(() => {
    if (!update.version || tab === "capture") return;
    if (promptedVersion.current === update.version) return;
    setUpdatePromptOpen(true);
  }, [update.version, tab]);

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
    openPortal()
      .then(() => setAnalysisActive(true))
      .catch((error) => setPortalError(String(error)));
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

  const acceptUpdate = () => {
    if (update.version) promptedVersion.current = update.version;
    setUpdatePromptOpen(false);
    // Install progress and any failure are shown in Settings → Updates, never
    // over a recording screen.
    navigate({ tab: "settings" });
    void update.install();
  };

  const deferUpdate = () => {
    if (update.version) promptedVersion.current = update.version;
    setUpdatePromptOpen(false);
    update.dismiss();
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

  const engineReady = !!engine?.runtime_found && !!engine?.inference_available;
  const syncFailed =
    sync.authRejected || notProvisioned || notConfigured || !!sync.lastError;
  const syncSucceeded = !syncFailed && !sync.syncing && !!sync.lastSyncAt;
  const engineDetail = !isTauri()
    ? "Browser mode — the native engine is unavailable."
    : !engine
      ? "Engine status is unavailable."
      : [
          `Engine ${engineReady ? "ready" : "not ready"}`,
          `Provider: ${engine.provider}`,
          `Runtime: ${engine.runtime_found ? "found" : "missing"}`,
          `Inference: ${engine.inference_available ? "available" : "unavailable"}`,
          engine.detail,
        ]
          .filter(Boolean)
          .join("\n");
  const syncDetail = [
    syncLabel,
    syncError && `Detail: ${syncError}`,
  ]
    .filter(Boolean)
    .join("\n");

  // Horizontal tabs: the active destination is marked by a thin underline
  // rather than a pill, matching the workstation's instrument-panel chrome.
  const navItem =
    "relative inline-flex h-full flex-1 items-center justify-center gap-2 px-3 text-sm font-medium transition-colors outline-none after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50";
  const navActive = "text-foreground after:bg-primary";
  const navIdle =
    "text-muted-foreground after:bg-transparent hover:text-foreground";

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
    <TooltipProvider delayDuration={200}>
    <div className="flex h-screen w-screen flex-col bg-background font-sans text-foreground">
      {/* Top bar — brand, destinations and compact status indicators. */}
      <header className="flex h-16 shrink-0 items-stretch border-b border-sidebar-border bg-sidebar px-4">
        <nav className="flex min-w-0 flex-1 items-stretch gap-1" aria-label="Main navigation">
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
            aria-current={analysisActive ? "page" : undefined}
            className={cn(navItem, analysisActive ? navActive : navIdle)}
          >
            <BarChart3 className="h-4 w-4" aria-hidden="true" />
            Analysis
            <ExternalLink
              className="h-3 w-3 text-muted-foreground/60"
              aria-hidden="true"
            />
          </button>
        </nav>

        <div className="flex items-center justify-end gap-2 pl-4">
          {patient && (
            <span
              className="hidden max-w-40 truncate rounded-full bg-sidebar-accent px-2.5 py-1 text-xs text-foreground md:inline"
              title={`Active patient: ${patient.name}`}
            >
              {patient.name}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                aria-label={engineReady ? "Engine ready" : "Engine not ready"}
                className="inline-flex size-8 items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2.5 rounded-full ring-2 ring-sidebar",
                    engineReady ? "bg-emerald-500" : "bg-red-500",
                  )}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs whitespace-pre-line">
              {engineDetail}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                aria-label={syncLabel}
                className="relative inline-flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <RefreshCw
                  className={cn("size-5", sync.syncing && "animate-spin")}
                  aria-hidden="true"
                />
                {syncFailed && (
                  <span className="absolute left-1/2 top-1/2 flex size-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-sidebar">
                    <X className="size-2.5 text-red-400" aria-hidden="true" />
                  </span>
                )}
                {syncSucceeded && (
                  <span className="absolute left-1/2 top-1/2 flex size-3.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-sidebar">
                    <Check className="size-2.5 text-emerald-400" aria-hidden="true" />
                  </span>
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs whitespace-pre-line">
              {syncDetail}
            </TooltipContent>
          </Tooltip>

          <button
            type="button"
            onClick={() => navigate({ tab: "settings" })}
            aria-label="Settings"
            title="Settings"
            className={cn(
              "inline-flex size-9 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
              tab === "settings"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Settings className="h-4 w-4" aria-hidden="true" />
          </button>
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
            "warm-scrollbar min-h-0 flex-1 overflow-y-auto p-6",
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

          {tab === "settings" && (
            <SettingsPage update={update} engine={engine} />
          )}
        </section>
      </main>

      {updatePromptOpen && update.version && (
        <AlertDialog open onOpenChange={(next) => !next && deferUpdate()}>
          <AlertDialogContent onOutsideDismiss={deferUpdate}>
            <AlertDialogHeader>
              <AlertDialogTitle>Update available</AlertDialogTitle>
              <AlertDialogDescription>
                Version {update.version}
                {update.currentVersion ? ` (current ${update.currentVersion})` : ""}{" "}
                is ready to install. You can also check for updates later in
                Settings → Updates.
                {update.notes && (
                  <span className="mt-2 block max-h-24 overflow-y-auto whitespace-pre-line text-xs text-muted-foreground">
                    {update.notes}
                  </span>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Later</AlertDialogCancel>
              <AlertDialogAction onClick={acceptUpdate}>Update now</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

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
    </TooltipProvider>
  );
}

export default App;
