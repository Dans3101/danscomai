import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { sendBridgeCommand } from "@/lib/mt5.functions";
import { ArrowDownRight, ArrowUpRight, Loader2, XOctagon } from "lucide-react";

type Cmd = {
  id: string; command: string; status: string; created_at: string;
  result: Record<string, unknown> | null;
};

export function TradePanel({ accountId, bid, ask }: { accountId: string; bid?: number | null; ask?: number | null }) {
  const send = useServerFn(sendBridgeCommand);
  const [volume, setVolume] = useState("0.01");
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [cmds, setCmds] = useState<Cmd[]>([]);

  const loadCmds = async () => {
    const { data } = await supabase
      .from("bridge_commands")
      .select("id, command, status, created_at, result")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(6);
    setCmds((data ?? []) as Cmd[]);
  };

  useEffect(() => {
    loadCmds();
    const ch = supabase
      .channel(`cmds_${accountId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "bridge_commands", filter: `account_id=eq.${accountId}` },
        loadCmds,
      )
      .subscribe();
    return () => void supabase.removeChannel(ch);
  }, [accountId]); // eslint-disable-line

  const queue = async (command: "open" | "close_all", payload: Record<string, unknown>, key: string) => {
    setBusy(key);
    try {
      await send({ data: { account_id: accountId, command, payload } });
      toast.success(`${command === "open" ? "Order" : "Close-all"} sent to MT5`);
      loadCmds();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to queue command");
    } finally {
      setBusy(null);
    }
  };

  const market = (side: "buy" | "sell") =>
    queue(
      "open",
      {
        symbol: "XAUUSD",
        side,
        volume: Number(volume),
        sl: sl ? Number(sl) : undefined,
        tp: tp ? Number(tp) : undefined,
        comment: "manual",
      },
      side,
    );

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="px-4 py-3 border-b border-border text-sm font-medium flex items-center gap-2">
        Manual trade · XAUUSD
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {bid != null ? `bid ${bid}` : "bid —"} / {ask != null ? `ask ${ask}` : "ask —"}
        </span>
      </div>
      <div className="p-4 space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Num label="Volume (lots)" value={volume} onChange={setVolume} step="0.01" />
          <Num label="Stop loss (price)" value={sl} onChange={setSl} step="any" />
          <Num label="Take profit (price)" value={tp} onChange={setTp} step="any" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => market("buy")}
            disabled={busy !== null}
            className="h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
          >
            {busy === "buy" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4 w-4" />}
            Buy {ask != null ? ask : ""}
          </button>
          <button
            onClick={() => market("sell")}
            disabled={busy !== null}
            className="h-10 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
          >
            {busy === "sell" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownRight className="h-4 w-4" />}
            Sell {bid != null ? bid : ""}
          </button>
        </div>
        <button
          onClick={() => queue("close_all", {}, "close_all")}
          disabled={busy !== null}
          className="w-full h-9 rounded-md border border-border text-sm hover:bg-accent inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
        >
          <XOctagon className="h-3.5 w-3.5" /> Close all positions
        </button>

        {cmds.length > 0 && (
          <ul className="pt-2 border-t border-border space-y-1 text-xs">
            {cmds.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <span className="font-medium">{c.command}</span>
                <span
                  className={
                    "px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider " +
                    (c.status === "done"
                      ? "bg-primary/10 text-primary"
                      : c.status === "failed"
                        ? "bg-destructive/10 text-destructive"
                        : "bg-muted text-muted-foreground")
                  }
                >
                  {c.status}
                </span>
                <span className="ml-auto text-muted-foreground tabular-nums">
                  {new Date(c.created_at).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Num({
  label, value, onChange, step,
}: { label: string; value: string; onChange: (v: string) => void; step: string }) {
  return (
    <label className="block">
      <span className="block text-xs text-muted-foreground mb-1">{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}
