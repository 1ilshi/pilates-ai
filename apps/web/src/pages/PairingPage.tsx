import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2, MonitorSmartphone, ShieldCheck, XCircle } from "lucide-react";
import { Badge, Button, Card } from "@pilates/ui";
import { useAuth } from "../lib/auth";

const PAIR_APPROVE_URL =
  "https://asia-east2-pilates-ai.cloudfunctions.net/pairApprove";

/** `ABCD-EFGH` for display, from whatever is in the URL. */
function displayCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length === 8 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
}

type State =
  | { kind: "ready" }
  | { kind: "approving" }
  | { kind: "approved" }
  | { kind: "error"; message: string };

/**
 * Approve a workstation that is waiting to pair.
 *
 * Reached from the desktop app, which opens
 * `/pair?code=ABCD-EFGH` in the browser. The signed-in clinician is the one
 * granting access, so the page states plainly what that access means.
 */
export function PairingPage() {
  const [params] = useSearchParams();
  const { user } = useAuth();
  const [state, setState] = useState<State>({ kind: "ready" });

  const code = displayCode(params.get("code") ?? "");

  useEffect(() => {
    document.title = "Pair a workstation — Pilates AI";
  }, []);

  const approve = async () => {
    if (!user) return;
    setState({ kind: "approving" });
    try {
      const token = await user.getIdToken(true);
      const response = await fetch(PAIR_APPROVE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ code }),
      });

      if (response.ok) {
        setState({ kind: "approved" });
        return;
      }

      const message =
        response.status === 410
          ? "That code has expired. Ask the workstation to show a new one."
          : response.status === 404
            ? "That code is not recognised. Check the workstation screen."
            : response.status === 403
              ? "This account cannot authorise a workstation. Sign in again and retry."
              : "The authorisation could not be completed. Try again.";
      setState({ kind: "error", message });
    } catch {
      setState({
        kind: "error",
        message: "Could not reach the pairing service. Check the connection.",
      });
    }
  };

  if (!code) {
    return (
      <Card className="mx-auto max-w-lg p-6">
        <h1 className="text-lg font-semibold text-slate-100">No code supplied</h1>
        <p className="mt-2 text-sm text-slate-400">
          Open this page from the workstation you want to authorise — the app
          provides the link and the code.
        </p>
        <Link to="/" className="mt-4 inline-block text-sm text-brand-400 hover:underline">
          Back to the overview
        </Link>
      </Card>
    );
  }

  if (state.kind === "approved") {
    return (
      <Card className="mx-auto max-w-lg p-6 text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400" aria-hidden="true" />
        <h1 className="mt-3 text-lg font-semibold text-slate-100">Workstation authorised</h1>
        <p className="mt-2 text-sm text-slate-400">
          {code} can now record sessions and sync to this clinic. You can close
          this tab — the workstation will continue on its own.
        </p>
      </Card>
    );
  }

  return (
    <Card className="mx-auto max-w-lg p-6">
      <div className="flex items-center gap-2">
        <MonitorSmartphone className="h-5 w-5 text-brand-400" aria-hidden="true" />
        <h1 className="text-lg font-semibold text-slate-100">
          Authorise this workstation?
        </h1>
        <Badge variant="brand">{code}</Badge>
      </div>

      <p className="mt-3 text-sm text-slate-400">
        A clinical workstation is waiting to be paired with this clinic.
      </p>

      <div className="mt-4 rounded-card border border-amber-500/30 bg-amber-500/5 p-3">
        <p className="flex items-center gap-2 text-xs font-medium text-amber-300">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          This workstation will be able to read and write patient records
        </p>
        <p className="mt-1.5 text-xs text-slate-400">
          Pairing grants the same access this account has, including patient
          details, clinical notes and session history. Only approve a machine you
          are setting up. Your name is recorded against it.
        </p>
      </div>

      {state.kind === "error" && (
        <p className="mt-3 flex items-start gap-2 text-sm text-red-300">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {state.message}
        </p>
      )}

      <div className="mt-5 flex items-center justify-between gap-3">
        <Link to="/" className="text-xs text-slate-500 hover:text-slate-300">
          Cancel
        </Link>
        <Button onClick={() => void approve()} disabled={state.kind === "approving"}>
          {state.kind === "approving" ? "Authorising…" : "Authorise workstation"}
        </Button>
      </div>
    </Card>
  );
}
