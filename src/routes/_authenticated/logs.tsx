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

  const reload = async () => {
    const { data } = await supabase
      .from("activity_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    setRows((data ?? []) as Log[]);
  };

  useEffect(() => {
    reload();
    const ch = supabase
      .channel("logs_rt")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "activity_logs" }, (p) => {
        setRows((prev) => [p.new as Log, ...prev].slice(0, 200));
      })
      .subscribe();
    return () => void supabase.removeChannel(ch);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-muted-foreground">Live feed of bridge, bot and system events.</p>
      </div>
      <div className="rounded-lg border border-border bg-card divide-y divide-border">
        {rows.length === 0 && (
          <div className="p-10 text-center text-sm text-muted-foreground">No activity yet.</div>
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