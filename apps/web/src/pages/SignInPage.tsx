import { useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { Button, Card, Input, Label, Logo } from "@pilates/ui";
import { useAuth } from "../lib/auth";

export function SignInPage() {
  const { signIn, error, clearError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await signIn(email, password);
    } catch {
      // The provider surfaces the message; nothing else to do here.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-6 text-foreground">
      {/* Soft teal studio glow behind the sign-in card. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="size-[36rem] rounded-full bg-primary/10 blur-[120px]" />
      </div>
      <Card className="relative w-full max-w-sm p-6 shadow-lift">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo className="h-12 w-12" />
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">Pilates AI Portal</h1>
            <p className="mt-1 text-xs text-muted-foreground">Clinical cloud access</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="signin-email">Email</Label>
            <Input
              id="signin-email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(event) => {
                clearError();
                setEmail(event.target.value);
              }}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="signin-password">Password</Label>
            <Input
              id="signin-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => {
                clearError();
                setPassword(event.target.value);
              }}
            />
          </div>

          {error && (
            <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <Button type="submit" loading={busy} className="w-full" size="lg">
            <Lock className="h-4 w-4" aria-hidden="true" />
            Sign in
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Accounts are managed in the Firebase console.
        </p>
      </Card>
    </div>
  );
}
