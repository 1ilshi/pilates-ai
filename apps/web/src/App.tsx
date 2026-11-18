import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { BarChart3, LayoutDashboard, LogOut, Users } from "lucide-react";
import { Badge, Button, Logo, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, cn, Toaster } from "@pilates/ui";
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
  const { pathname } = useLocation();

  // The desktop opens `/auth#code=…` to hand this browser its session. The
  // bridge must render before the signed-out gate, and it navigates away when
  // the exchange succeeds.
  if (window.location.pathname.replace(/\/+$/, "") === "/auth") {
    return <AuthBridgePage />;
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
        Loading…
      </div>
    );
  }

  if (!user) return <SignInPage />;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-screen bg-background font-sans text-foreground">
        {/* Studio rail — circular icon buttons, the active route as a solid
            teal disc. Desktop affordance only; phones keep the bottom bar. */}
        <aside className="sticky top-0 hidden h-screen shrink-0 flex-col items-center gap-1.5 border-r border-sidebar-border bg-sidebar px-3 py-5 sm:flex">
          <Logo className="mb-4 h-9 w-9 shrink-0" />

          <nav className="flex flex-col items-center gap-1.5" aria-label="Main navigation">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <Tooltip key={to}>
                <TooltipTrigger asChild>
                  <NavLink
                    to={to}
                    end={end}
                    aria-label={label}
                    className={cn(
                      "flex size-11 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      (end ? pathname === to : pathname.startsWith(to))
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <Icon className="size-5" aria-hidden="true" />
                  </NavLink>
                </TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
            ))}
          </nav>

          <div className="mt-auto flex flex-col items-center gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="max-w-12 cursor-default truncate text-[10px] text-muted-foreground" title={user.email ?? ""}>
                  {user.email}
                </span>
              </TooltipTrigger>
              <TooltipContent side="right">{user.email}</TooltipContent>
            </Tooltip>
            <Button variant="ghost" size="icon" onClick={() => void signOutUser()} aria-label="Sign out">
              <LogOut className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          {/* Compact identity strip for phones; the rail is hidden there. */}
          <header className="flex items-center gap-2 px-4 py-3 sm:hidden">
            <Logo className="h-7 w-7 shrink-0" />
            <span className="truncate font-display text-lg font-semibold tracking-tight">Pilates AI</span>
            <Badge variant="secondary" className="ml-auto">Clinical Cloud</Badge>
            <Button variant="ghost" size="icon" onClick={() => void signOutUser()} aria-label="Sign out">
              <LogOut className="size-4" aria-hidden="true" />
            </Button>
          </header>

          <main className="mx-auto w-full min-w-0 max-w-6xl p-4 pb-24 sm:p-8 sm:pb-10">
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
        </div>

        {/* Thumb-reachable navigation, phones only. */}
        <nav
          className="fixed inset-x-0 bottom-0 z-20 border-t border-sidebar-border bg-sidebar/95 backdrop-blur sm:hidden"
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
                    isActive ? "text-primary" : "text-muted-foreground active:bg-accent/60",
                  )
                }
              >
                <Icon className="size-5" aria-hidden="true" />
                {label}
              </NavLink>
            ))}
          </div>
        </nav>
        <Toaster position="bottom-right" />
      </div>
    </TooltipProvider>
  );
}

export default App;
