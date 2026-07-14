import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useNavigate, Link } from "@tanstack/react-router";
import { ArrowRight, ShieldCheck, Activity, LineChart } from "lucide-react";

export const Route = createFileRoute("/")({
  ssr: false,
  component: Index,
});

function Index() {
  const navigate = useNavigate();
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) navigate({ to: "/dashboard", replace: true });
    });
  }, [navigate]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
        <div className="font-semibold tracking-tight">MT5<span className="text-primary">·</span>AutoTrader</div>
        <Link to="/auth" className="text-sm text-muted-foreground hover:text-foreground">Sign in</Link>
      </header>
      <section className="mx-auto max-w-6xl px-6 pt-16 pb-24">
        <div className="max-w-2xl">
          <span className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
            <span className="h-1 w-1 rounded-full bg-primary" /> Personal trading platform
          </span>
          <h1 className="mt-4 text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.05]">
            Automated MetaTrader 5,<br />engineered for one trader — you.
          </h1>
          <p className="mt-5 text-lg text-muted-foreground max-w-xl">
            Connect your MT5 account through a secure bridge, define your rules and risk, and let the bot handle execution while you watch a clean live dashboard.
          </p>
          <div className="mt-8 flex items-center gap-3">
            <Link
              to="/auth"
              className="inline-flex items-center gap-2 h-11 px-5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
            >
              Get started <ArrowRight className="h-4 w-4" />
            </Link>
            <a href="#how" className="text-sm text-muted-foreground hover:text-foreground">How it works</a>
          </div>
        </div>

        <div id="how" className="mt-24 grid gap-6 sm:grid-cols-3">
          {[
            { icon: ShieldCheck, title: "Secure bridge", body: "Credentials encrypted at rest. Your MT5 password never leaves your control." },
            { icon: Activity, title: "Live sync", body: "Balance, equity, positions, orders and P/L stream in real time." },
            { icon: LineChart, title: "Rule-based bot", body: "MA crossover, RSI, breakout — with lot, SL, TP, trailing stop and daily loss caps." },
          ].map((f) => (
            <div key={f.title} className="p-5 rounded-lg border border-border bg-card">
              <f.icon className="h-4 w-4 text-primary" />
              <div className="mt-3 font-medium">{f.title}</div>
              <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
