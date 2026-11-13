import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button, Card } from "@pilates/ui";
import { openExternal, pairingPoll, pairingStart, type PairingStart } from "../lib/ipc";

const PORTAL_PAIR_URL = "https://pilates-ai.web.app/pair";

/** The portal URL for a code, shown as text as well as opened. */
function pairUrl(code: string): string {
  return `${PORTAL_PAIR_URL}?code=${encodeURIComponent(code)}`;
}

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; pairing: PairingStart }
  | { kind: "expired"; pairing: PairingStart }
  | { kind: "error"; message: string };

/**
 * First-run pairing for a shared or unattended machine.
 *
 * Shown when the workstation has **no credential at all**, or when someone
 * chooses it from the sign-in screen. A credential that exists but is rejected
 * never reaches this screen — the app opens and shows a banner instead, because
 * a credential problem that hides the patient list is indistinguishable from
 * data loss.
 */
export function PairingGate({
  onPaired,
  onBack,
}: {
  onPaired: () => void;
  /** Present when the sign-in screen offered pairing as an alternative. */
  onBack?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [remaining, setRemaining] = useState(0);
  // Set when the browser could not be launched, so the URL can be shown.
  const [openError, setOpenError] = useState<string | null>(null);
  const polling = useRef<number | null>(null);
  const deadline = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (polling.current !== null) {
      window.clearInterval(polling.current);
      polling.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const begin = useCallback(async () => {
    stopPolling();
    setPhase({ kind: "starting" });
    try {
      const pairing = await pairingStart();
      setPhase({ kind: "waiting", pairing });
      deadline.current = Date.parse(pairing.expires_at) || Date.now() + 600_000;

      // Open the portal once. A failure is recorded rather than swallowed: the
      // code is also shown as text below, so the user is never stuck.
      void openExternal(pairUrl(pairing.code)).catch((error) =>
        setOpenError(String(error)),
      );

      polling.current = window.setInterval(async () => {
        if (Date.now() > deadline.current) {
          stopPolling();
          setPhase({ kind: "expired", pairing });
          return;
        }
        try {
          const done = await pairingPoll(pairing.code, pairing.secret);
          if (done) {
            stopPolling();
            onPaired();
          }
        } catch {
          // A transient poll failure is not worth surfacing; the next tick
          // retries, and the code expires visibly if it never succeeds.
        }
      }, 2000);
    } catch (error) {
      setPhase({ kind: "error", message: String(error) });
    }
  }, [onPaired, stopPolling]);

  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const timer = window.setInterval(() => {
      const left = Math.max(0, Math.round((deadline.current - Date.now()) / 1000));
      setRemaining(left);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phase.kind]);

  const pairing = phase.kind === "waiting" || phase.kind === "expired" ? phase.pairing : null;

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-slate-950 p-6">
      <Card className="w-full max-w-md p-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-brand-400" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-slate-100">Pair this workstation</h1>
        </div>

        <p className="mt-2 text-sm text-slate-400">
          This machine is not linked to a clinic yet. Pair it once, and it will
          open straight to the workstation from then on — no sign-in on every
          launch.
        </p>

        {phase.kind === "error" && (
          <p className="mt-3 rounded-control border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-300">
            {phase.message}
          </p>
        )}

        {pairing && (
          <div className="mt-5 rounded-card border border-slate-800 bg-slate-900/50 p-4 text-center">
            <p className="text-xs text-slate-500">Enter this code in the portal</p>
            <p className="mt-1 font-mono text-3xl font-bold tracking-[0.2em] text-slate-50">
              {pairing.code}
            </p>
            {phase.kind === "waiting" ? (
              <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-slate-500">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                Waiting for approval… {remaining > 0 ? `${remaining}s left` : ""}
              </p>
            ) : (
              <p className="mt-2 text-xs text-amber-400">
                That code expired. Ask for a new one below.
              </p>
            )}
          </div>
        )}

        {phase.kind === "waiting" && (
          <p className="mt-3 text-center text-xs text-slate-500">
            The portal should have opened in your browser. Sign in as a clinician
            and approve the code.
          </p>
        )}

        {openError && pairing && (
          <div className="mt-3 rounded-control border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
            <p>Could not open the browser automatically. Open this address yourself:</p>
            <p className="mt-1 select-all break-all font-mono text-[11px] text-amber-100">
              {pairUrl(pairing.code)}
            </p>
            <p className="mt-1 text-amber-300/70">{openError}</p>
          </div>
        )}

        <div className="mt-5 space-y-2">
          {pairing && phase.kind === "waiting" && (
            <Button
              variant="secondary"
              className="w-full"
              onClick={() =>
                void openExternal(pairUrl(pairing.code)).catch((error) =>
                  setOpenError(String(error)),
                )
              }
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open the portal again
            </Button>
          )}

          {phase.kind !== "waiting" && (
            <Button
              className="w-full"
              onClick={() => void begin()}
              disabled={phase.kind === "starting"}
            >
              {phase.kind === "starting" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Getting a code…
                </>
              ) : phase.kind === "expired" || phase.kind === "error" ? (
                <>
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  Get a new code
                </>
              ) : (
                <>
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                  Pair this workstation
                </>
              )}
            </Button>
          )}
        </div>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-slate-600">
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          Needs internet once. After pairing it works offline.
        </p>

        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="mt-3 flex w-full items-center justify-center gap-1.5 text-[11px] text-slate-500 hover:text-slate-300"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden="true" />
            Sign in with an account instead
          </button>
        )}
      </Card>
    </div>
  );
}
