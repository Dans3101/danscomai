import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { LineChart, Plug, Sliders, ScrollText, LogOut } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: LineChart },
  { to: "/accounts", label: "Accounts", icon: Plug },
  { to: "/strategies", label: "Strategies", icon: Sliders },
  { to: "/logs", label: "Activity", icon: ScrollText },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const signOut = async () => {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-background/80 backdrop-blur sticky top-0 z-20">
        <div className="mx-auto max-w-7xl px-4 h-14 flex items-center gap-6">
          <Link to="/dashboard" className="font-semibold tracking-tight text-[15px]">
            MT5<span className="text-primary">·</span>AutoTrader
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {nav.map((n) => {
              const active = loc.pathname.startsWith(n.to);
              const Icon = n.icon;
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/60",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <button
            onClick={signOut}
            className="ml-auto inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
    </div>
  );
}