import { useState, type FormEvent } from "react";
import { KeyRound, Lock } from "lucide-react";
import { Button, Card, Checkbox, Input, Label } from "@pilates/ui";
import { authSignIn } from "../lib/ipc";
import { Logo } from "./Logo";
import { PairingGate } from "./PairingGate";

/** Remembered so a returning colleague does not retype their address. */
const LAST_EMAIL_KEY = "pilates.last-email";

function rememberedEmail(): string {
  try {
    return localStorage.getItem(LAST_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberEmail(email: string) {
  try {
    localStorage.setItem(LAST_EMAIL_KEY, email);
  } catch {
    // A locked-down webview can refuse storage; never fail sign-in over it.
  }
}

/** Strip the engine's `sync: ` prefix so the message reads like a sentence. */
function readable(error: unknown): string {
  const text = String(error ?? "").replace(
    /^(sync|storage|configuration|invalid input|io|json):\s*/i,
    "",
  );
  return text || "Sign-in failed. Try again.";
}

/**
 * First-run access: sign in, or pair a shared machine.
 *
 * Sign-in is the default because it is one screen and one credential — the
 * shortest path for a colleague installing the app on their own laptop. Pairing
 * stays available for a shared or unattended workstation, where nobody should
 * have to type a clinic password on a tablet.
 */
export function AccessGate({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<"signin" | "pair">("signin");
  const [email, setEmail] = useState(rememberedEmail);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (mode === "pair") {
    return <PairingGate onPaired={onSignedIn} onBack={() => setMode("signin")} />;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await authSignIn(email.trim(), password);
      rememberEmail(email.trim());
      onSignedIn();
    } catch (caught) {
      setError(readable(caught));
      // Keep the email: a mistyped password becomes a one-field fix.
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md p-6">
        <div className="flex items-center gap-2.5">
          <Logo className="h-9 w-9 shrink-0" />
          <div>
            <h1 className="text-lg font-semibold text-foreground">Pilates AI</h1>
            <p className="text-xs text-muted-foreground">Clinical workstation</p>
          </div>
        </div>

        <p className="mt-5 text-sm font-medium text-foreground">Sign in to start</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Use the clinic account your supervisor gave you.
        </p>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="access-email">Email</Label>
            <Input
              id="access-email"
              type="email"
              autoComplete="username"
              required
              autoFocus={!email}
              value={email}
              onChange={(event) => {
                setError(null);
                setEmail(event.target.value);
              }}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="access-password">Password</Label>
            <Input
              id="access-password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              autoFocus={Boolean(email)}
              value={password}
              onChange={(event) => {
                setError(null);
                setPassword(event.target.value);
              }}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="access-show-password"
              checked={showPassword}
              onCheckedChange={(checked) => setShowPassword(checked === true)}
              className="size-3.5"
            />
            <Label
              htmlFor="access-show-password"
              className="text-xs font-normal text-muted-foreground"
            >
              Show password
            </Label>
          </div>

          {error && (
            <p className="rounded-control border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <Button type="submit" loading={busy} className="w-full" size="lg">
            <Lock className="h-4 w-4" aria-hidden="true" />
            Sign in
          </Button>
        </form>

        <div className="mt-5 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setMode("pair")}
            className="flex items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground/80"
          >
            <KeyRound className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Shared or unattended machine? Pair it with a code instead.
          </button>
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground/70">
          The internet is needed once, to sign in. After that this workstation
          works offline.
        </p>
      </Card>
    </div>
  );
}
