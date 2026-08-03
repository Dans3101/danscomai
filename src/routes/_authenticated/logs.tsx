import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_authenticated/logs")({
  component: LogsPage,
});

type Log = {
  id: number; level: string; source: string; message: string;
  data: unknown; created_at: string;
};

function LogsPage() {
  const [rows, setRows] = useState<Log[]>([]);
  const [tab, setTab] = useState<"all" | "services">("all");

  const reload = async (mode: "all" | "services" = tab) => {
    let q = supabase
      .from("activity_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (mode === "services") {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      q = q
        .in("source", ["hub", "companion", "bridge"])
        .in("level", ["warn", "error"])
        .gte("created_at", since);
    }
    const { data } = await q;
    setRows((data ?? []) as Log[]);
  };

  useEffect(() => {
    reload(tab);
  }, [tab]);

  useEffect(() => {
    const ch = supabase
      .channel("logs_rt")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_logs" }, (p) => {
        const row = p.new as Log;
        if (tab === "services" && !(["hub", "companion", "bridge"].includes(row.source) && row.level !== "info"))
          return;
        setRows((prev) => [row, ...prev].slice(0, 200));
      })
      .subscribe();
    return () => void supabase.removeChannel(ch);
  }, [tab]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
          <p className="text-sm text-muted-foreground">
            {tab === "all"
              ? "Live feed of bridge, bot and system events."
              : "Hub & Companion warnings and errors from the last 24 hours."}
          </p>
        </div>
        <div className="inline-flex rounded-md border border-border bg-card p-0.5 text-sm">
          {(
            [
              ["all", "All activity"],
              ["services", "Service errors (24h)"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={
                "px-3 py-1.5 rounded transition-colors " +
                (tab === key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        {rows.length === 0 && (
          <div className="p-10 text-center text-sm text-muted-foreground">
            {tab === "services" ? "No Hub or Companion errors in the last 24 hours." : "No activity yet."}
          </div>
        )}
        {rows.map((l) => (
          <div key={l.id} className="p-3 flex items-start gap-3 text-sm">
            <span
              className={
                "mt-0.5 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 " +
                (l.level === "error"
                  ? "bg-destructive/10 text-destructive"
                  : l.level === "warn"
                    ? "bg-amber-500/10 text-amber-700"
                    : "bg-primary/10 text-primary")
              }
            >
              {l.level}
            </span>
            <span className="text-muted-foreground text-xs shrink-0 w-14">{l.source}</span>
            <span className="flex-1 min-w-0 break-words">{l.message}</span>
            <span className="text-xs text-muted-foreground shrink-0">
              {formatDistanceToNow(new Date(l.created_at))} ago
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}