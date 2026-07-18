import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Plus, Trash2, Power } from "lucide-react";

export const Route = createFileRoute("/_authenticated/strategies")({
  component: StrategiesPage,
});

type Strategy = {
  id: string; account_id: string; name: string; symbol: string; timeframe: string;
  rule_type: string; rule_params: Record<string, unknown>;
  lot_size: number; stop_loss_pips: number | null; take_profit_pips: number | null;
  trailing_stop_pips: number | null; max_daily_loss: number | null;
  max_open_trades: number; enabled: boolean;
};
type Account = { id: string; label: string; login: string };

const RULE_TYPES = [
  { value: "ma_crossover", label: "MA Crossover", params: [{ k: "fast", d: 9 }, { k: "slow", d: 21 }] },
  { value: "rsi", label: "RSI Overbought/Oversold", params: [{ k: "period", d: 14 }, { k: "oversold", d: 30 }, { k: "overbought", d: 70 }] },
  { value: "breakout", label: "Range Breakout", params: [{ k: "lookback", d: 20 }] },
  {
    value: "smc_confluence",
    label: "SMC Confluence (45-rule)",
    params: [
      { k: "ema_period", d: 200 },
      { k: "rsi_buy_min", d: 55 },
      { k: "rsi_sell_max", d: 45 },
      { k: "atr_period", d: 14 },
      { k: "atr_min_pips", d: 5 },
      { k: "atr_max_pips", d: 80 },
      { k: "vol_lookback", d: 20 },
      { k: "bos_lookback", d: 20 },
      { k: "sweep_lookback", d: 10 },
      { k: "min_rr", d: 3 },
      { k: "max_spread_pips", d: 3 },
      { k: "min_confidence", d: 85 },
      { k: "cooldown_min", d: 15 },
      { k: "breakeven_rr", d: 1 },
      { k: "trailing_rr", d: 1.5 },
      { k: "max_hold_min", d: 240 },
      { k: "session_london", d: 1 },
      { k: "session_ny", d: 1 },
    ],
  },
] as const;

function StrategiesPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [rows, setRows] = useState<Strategy[]>([]);
  const [showForm, setShowForm] = useState(false);

  const reload = async () => {
    const [a, s] = await Promise.all([
      supabase.from("mt5_accounts").select("id, label, login").order("created_at"),
      supabase.from("strategies").select("*").order("created_at", { ascending: false }),
    ]);
    setAccounts((a.data ?? []) as Account[]);
    setRows((s.data ?? []) as Strategy[]);
  };
  useEffect(() => { reload(); }, []);

  const toggle = async (s: Strategy) => {
    await supabase.from("strategies").update({ enabled: !s.enabled }).eq("id", s.id);
    toast.success(s.enabled ? "Strategy paused" : "Strategy enabled");
    reload();
  };
  const remove = async (id: string) => {
    if (!confirm("Delete this strategy?")) return;
    await supabase.from("strategies").delete().eq("id", id);
    reload();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Strategies</h1>
          <p className="text-sm text-muted-foreground">Rule-based strategies with risk controls. The bridge executes them.</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          disabled={!accounts.length}
          className="ml-auto inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> New strategy
        </button>
      </div>

      {!accounts.length && (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Add an MT5 account first, then create strategies for it.
        </div>
      )}

      <div className="grid gap-3">
        {rows.map((s) => {
          const acct = accounts.find((a) => a.id === s.account_id);
          return (
            <div key={s.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    <span className={"text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded " + (s.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                      {s.enabled ? "Active" : "Paused"}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {acct?.label ?? "—"} · {s.symbol} {s.timeframe} · {RULE_TYPES.find((r) => r.value === s.rule_type)?.label ?? s.rule_type}
                  </div>
                </div>
                <button onClick={() => toggle(s)} className="h-8 px-3 rounded-md border border-border hover:bg-accent inline-flex items-center gap-1 text-xs">
                  <Power className="h-3 w-3" /> {s.enabled ? "Pause" : "Enable"}
                </button>
                <button onClick={() => remove(s.id)} className="h-8 w-8 grid place-items-center rounded-md border border-border hover:bg-destructive/10 hover:text-destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-3 grid grid-cols-2 md:grid-cols-6 gap-3 text-xs">
                <Meta label="Lot">{s.lot_size}</Meta>
                <Meta label="SL (pips)">{s.stop_loss_pips ?? "—"}</Meta>
                <Meta label="TP (pips)">{s.take_profit_pips ?? "—"}</Meta>
                <Meta label="Trailing">{s.trailing_stop_pips ?? "—"}</Meta>
                <Meta label="Daily loss cap">{s.max_daily_loss ?? "—"}</Meta>
                <Meta label="Max open">{s.max_open_trades}</Meta>
              </div>
            </div>
          );
        })}
      </div>

      {showForm && (
        <StrategyForm
          accounts={accounts}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); reload(); }}
        />
      )}
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="uppercase tracking-wider text-[10px] text-muted-foreground">{label}</div>
      <div className="tabular-nums">{children}</div>
    </div>
  );
}

function StrategyForm({ accounts, onClose, onSaved }: { accounts: Account[]; onClose: () => void; onSaved: () => void }) {
  const [ruleType, setRuleType] = useState<(typeof RULE_TYPES)[number]["value"]>("ma_crossover");
  const rule = RULE_TYPES.find((r) => r.value === ruleType)!;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const params: Record<string, number> = {};
    rule.params.forEach((p) => { params[p.k] = Number(fd.get(`p_${p.k}`) ?? p.d); });

    const { data: user } = await supabase.auth.getUser();
    const { error } = await supabase.from("strategies").insert({
      user_id: user.user!.id,
      account_id: String(fd.get("account_id")),
      name: String(fd.get("name")),
      symbol: String(fd.get("symbol")).toUpperCase(),
      timeframe: String(fd.get("timeframe")),
      rule_type: ruleType,
      rule_params: params,
      lot_size: Number(fd.get("lot_size")),
      stop_loss_pips: numOrNull(fd.get("stop_loss_pips")),
      take_profit_pips: numOrNull(fd.get("take_profit_pips")),
      trailing_stop_pips: numOrNull(fd.get("trailing_stop_pips")),
      max_daily_loss: numOrNull(fd.get("max_daily_loss")),
      max_open_trades: Number(fd.get("max_open_trades") ?? 1),
      enabled: false,
    });
    if (error) return toast.error(error.message);
    toast.success("Strategy created");
    onSaved();
  };

  return (
    <div className="fixed inset-0 bg-foreground/20 backdrop-blur-sm grid place-items-center z-30 p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-lg border border-border bg-card p-6 space-y-3 max-h-[90vh] overflow-y-auto"
      >
        <h2 className="text-lg font-semibold">New strategy</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field name="name" label="Name" required placeholder="EURUSD Trend" />
          <label className="block">
            <span className="block text-xs text-muted-foreground mb-1">Account</span>
            <select name="account_id" required className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.label} · #{a.login}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs text-muted-foreground mb-1">Symbol</span>
            <input
              name="symbol"
              value="XAUUSD"
              readOnly
              aria-label="Symbol"
              className="w-full h-10 px-3 rounded-md border border-input bg-muted text-sm text-muted-foreground cursor-not-allowed"
            />
            <span className="block text-[10px] text-muted-foreground mt-1">Gold only (more pairs coming soon).</span>
          </label>
          <label className="block">
            <span className="block text-xs text-muted-foreground mb-1">Timeframe</span>
            <select name="timeframe" defaultValue="M15" className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm">
              {["M1","M5","M15","M30","H1","H4","D1"].map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
        </div>

        <label className="block">
          <span className="block text-xs text-muted-foreground mb-1">Rule</span>
          <select
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value as typeof ruleType)}
            className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
          >
            {RULE_TYPES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>

        <div className="grid grid-cols-3 gap-3">
          {rule.params.map((p) => (
            <Field key={p.k} name={`p_${p.k}`} label={p.k} type="number" defaultValue={p.d} step="any" />
          ))}
        </div>

        <div className="pt-2 border-t border-border">
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Risk management</div>
          <div className="grid grid-cols-3 gap-3">
            <Field name="lot_size" label="Lot size" type="number" step="0.01" defaultValue="0.01" required />
            <Field name="max_open_trades" label="Max open" type="number" defaultValue="1" required />
            <Field name="max_daily_loss" label="Daily loss cap ($)" type="number" step="any" />
            <Field name="stop_loss_pips" label="Stop loss (pips)" type="number" step="any" />
            <Field name="take_profit_pips" label="Take profit (pips)" type="number" step="any" />
            <Field name="trailing_stop_pips" label="Trailing stop (pips)" type="number" step="any" />
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose} className="flex-1 h-10 rounded-md border border-border text-sm hover:bg-accent">
            Cancel
          </button>
          <button type="submit" className="flex-1 h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90">
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...rest } = props;
  return (
    <label className="block">
      <span className="block text-xs text-muted-foreground mb-1">{label}</span>
      <input
        {...rest}
        className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}

function numOrNull(v: FormDataEntryValue | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}