import { useEffect, useRef, useState } from "react";
import { Activity, Loader2, XCircle } from "lucide-react";
import { signInWithCustomToken } from "firebase/auth";
import { Card } from "@pilates/ui";
import { auth } from "../lib/firebase";

const EXCHANGE_URL =
  "https://asia-east2-pilates-ai.cloudfunctions.net/portalLoginExchange";

/** Read the one-time code from the fragment, falling back to the query. */
function readCode(): string {
  const hash = window.location.hash.replace(/^#/, "");
  const fromHash = new URLSearchParams(hash).get("code");
  if (fromHash) return fromHash.trim();
  return (new URLSearchParams(window.location.search).get("code") ?? "").trim();
}

function explain(status: number): string {
  switch (status) {
    case 410:
      return "That sign-in link expired. Open Analysis from the workstation again.";
    case 404:
      return "That sign-in link is not valid. Open Analysis from the workstation again.";
    case 429:
      return "Too many attempts. Wait a minute and open Analysis again.";
    default:
      return "The workstation could not sign you in. Try opening Analysis again.";
  }
}

/**
 * Exchange the desktop's one-time code for a portal session.
 *
 * The desktop opens `/auth#code=…`; the code never reaches a server log, is
 * valid for 60 seconds, and is deleted as it is exchanged. On success the
 * portal reloads into the signed-in view as the same account.
 */
export function AuthBridgePage() {
  const [message, setMessage] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // StrictMode runs effects twice in development; one exchange per mount.
    if (started.current) return;
    started.current = true;

    const code = readCode();
    if (!code) {
      setMessage("Open Analysis from the workstation to sign in.");
      return;
    }

    void (async () => {
      try {
        const response = await fetch(EXCHANGE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });

        if (!response.ok) {
          setMessage(explain(response.status));
          return;
        }

        const payload = (await response.json()) as { custom_token?: string };
        if (!payload.custom_token) {
          setMessage("The workstation could not sign you in. Try again.");
          return;
        }

        await signInWithCustomToken(auth, payload.custom_token);
        // A reload is the simplest way to leave the bridge route and drop the
        // code from history; the session is already persisted.
        window.location.replace("/");
      } catch {
        setMessage(
          "Could not reach the sign-in service. Check the connection and open Analysis again.",
        );
      }
    })();
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
      <Card className="w-full max-w-sm p-6 text-center">
        <div className="mb-4 flex items-center justify-center gap-2">
          <Activity className="h-6 w-6 text-brand-400" aria-hidden="true" />
          <span className="text-lg font-bold text-white">Pilates AI Portal</span>
        </div>

        {message ? (
          <>
            <XCircle className="mx-auto h-8 w-8 text-red-400" aria-hidden="true" />
            <p className="mt-3 text-sm text-red-300">{message}</p>
            <a
              href="/"
              className="mt-4 inline-block text-sm text-brand-400 hover:underline"
            >
              Sign in manually
            </a>
          </>
        ) : (
          <>
            <Loader2
              className="mx-auto h-8 w-8 animate-spin text-brand-400"
              aria-hidden="true"
            />
            <p className="mt-3 text-sm text-slate-400">Signing you in…</p>
          </>
        )}
      </Card>
    </div>
  );
}
