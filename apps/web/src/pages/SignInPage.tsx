import { useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { Button, Card, Logo } from "@pilates/ui";
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
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2">
          <Logo className="h-8 w-8" />
          <div>
            <h1 className="text-lg font-bold text-white">Pilates AI Portal</h1>
            <p className="text-xs text-slate-500">Clinical cloud access</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Email</span>
            <input
              data-autofocus
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => {
                clearError();
                setEmail(event.target.value);
              }}
              className="h-10 w-full rounded-control border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 focus:border-brand-500 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => {
                clearError();
                setPassword(event.target.value);
              }}
              className="h-10 w-full rounded-control border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 focus:border-brand-500 focus:outline-none"
            />
          </label>

          {error && (
            <p className="rounded-control border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <Button type="submit" loading={busy} fullWidth size="lg">
            <Lock className="h-4 w-4" aria-hidden="true" />
            Sign in
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-500">
          Accounts are managed in the Firebase console.
        </p>
      </Card>
    </div>
  );
}
