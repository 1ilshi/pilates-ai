import { NavLink, Route, Routes } from "react-router-dom";
import { Activity, BarChart3, LayoutDashboard, LogOut, Users } from "lucide-react";
import { Badge, Button, cn } from "@pilates/ui";
import { useAuth } from "./lib/auth";
import { SignInPage } from "./pages/SignInPage";
import { AuthBridgePage } from "./pages/AuthBridgePage";
import { OverviewPage } from "./pages/OverviewPage";
import { PatientsPage } from "./pages/PatientsPage";
import { PatientPage } from "./pages/PatientPage";
import { SessionPage } from "./pages/SessionPage";
import { AnalysisPage } from "./pages/AnalysisPage";
import { PairingPage } from "./pages/PairingPage";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/patients", label: "Patients", icon: Users, end: false },
  { to: "/analysis", label: "Analysis", icon: BarChart3, end: false },
];

export function App() {
  const { user, loading, signOutUser } = useAuth();

  // The desktop opens `/auth#code=…` to hand this browser its session. The
  // bridge must render before the signed-out gate, and it navigates away when
  // the exchange succeeds.
  if (window.location.pathname.replace(/\/+$/, "") === "/auth") {
    return <AuthBridgePage />;
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 bg-slate-950 text-sm text-slate-400">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-700 border-t-brand-400" />
        Loading…
      </div>
    );
  }

  if (!user) return <SignInPage />;

  return (
    <div className="flex min-h-screen flex-col overflow-x-clip bg-slate-950 font-sans text-slate-100">
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-900/70 px-4 py-2.5 backdrop-blur sm:px-6 sm:py-3">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <Activity className="h-6 w-6 shrink-0 text-brand-400" aria-hidden="true" />
            {/* The wordmark and badge cost ~250px; the mark alone carries the
                identity on a phone. */}
            <span className="hidden truncate text-lg font-bold tracking-tight text-white sm:inline">
              Pilates AI Portal
            </span>
            <span className="truncate text-base font-bold tracking-tight text-white sm:hidden">
              Pilates AI
            </span>
            <Badge variant="brand" className="hidden sm:inline-flex">
              Clinical Cloud
            </Badge>
          </div>

          {/* Inline navigation is a desktop affordance; phones get the bar below. */}
          <nav className="hidden items-center gap-1 sm:flex" aria-label="Main navigation">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    "inline-flex items-center gap-2 rounded-control px-3 py-1.5 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-brand-500/10 text-brand-400"
                      : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
                  )
                }
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <span className="hidden text-xs text-slate-500 lg:inline">{user.email}</span>
            <Button variant="ghost" size="sm" onClick={() => void signOutUser()}>
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      {/* Bottom padding clears the fixed tab bar on phones. */}
      <main className="mx-auto w-full min-w-0 max-w-7xl flex-1 p-4 pb-24 sm:p-6 sm:pb-6">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/patients" element={<PatientsPage />} />
          <Route path="/analysis" element={<AnalysisPage />} />
          <Route path="/patients/:id" element={<PatientPage />} />
          <Route path="/patients/:patientId/sessions/:sessionId" element={<SessionPage />} />
          <Route path="/pair" element={<PairingPage />} />
          <Route path="*" element={<OverviewPage />} />
        </Routes>
      </main>

      {/* Thumb-reachable navigation, phones only. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-800 bg-slate-900/95 backdrop-blur sm:hidden"
        aria-label="Main navigation"
      >
        <div className="grid grid-cols-3">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex min-h-[56px] flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors",
                  isActive ? "text-brand-400" : "text-slate-500 active:bg-slate-800/60",
                )
              }
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

export default App;
