import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow } from "date-fns";
import { Activity, Wifi, WifiOff } from "lucide-react";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardPage,
});

type Account = {
  id: string; label: string; broker: string; login: string; server: string;
  connection_status: string; last_seen_at: string | null;
};
type Snapshot = {
  balance: number | null; equity: number | null; margin: number | null;
  free_margin: number | null; margin_level: number | null; profit: number | null;
  currency: string | null; captured_at: string;
};
type Position = {
  id: string; ticket: number; symbol: string; side: string; volume: number;
  open_price: number | null; current_price: number | null;
  stop_loss: number | null; take_profit: number | null; profit: number | null;
};
type Order = {
  id: string; ticket: number; symbol: string; type: string; volume: number;
  price: number | null; stop_loss: number | null; take_profit: number | null;
};
type Trade = {
  id: string; ticket: number; symbol: string; side: string; volume: number;
  profit: number | null; closed_at: string | null;
};

function DashboardPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [history, setHistory] = useState<Trade[]>([]);

  // load accounts once
  useEffect(() => {
    supabase
      .from("mt5_accounts")
      .select("id, label, broker, login, server, connection_status, last_seen_at")
      .order("created_at")
      .then(({ data }) => {
        setAccounts((data ?? []) as Account[]);
        if (data && data.length && !selected) setSelected(data[0].id);
      });
  }, []); // eslint-disable-line

  // realtime account status
  useEffect(() => {
    const ch = supabase
      .channel("mt5_accounts_rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "mt5_accounts" }, (p) => {
        setAccounts((prev) =>
          prev.map((a) => (a.id === (p.new as Account)?.id ? { ...a, ...(p.new as Account) } : a)),
        );
      })
      .subscribe();
    return () => void supabase.removeChannel(ch);
  }, []);

  // load per-account data + realtime
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;

    const loadAll = async () => {
      const [snap, pos, ord, hist] = await Promise.all([
        supabase
          .from("account_snapshots")
          .select("*")
          .eq("account_id", selected)
          .order("captured_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase.from("positions").select("*").eq("account_id", selected).order("opened_at"),
        supabase.from("pending_orders").select("*").eq("account_id", selected).order("placed_at"),
        supabase
          .from("trade_history")
          .select("*")
          .eq("account_id", selected)
          .order("closed_at", { ascending: false })
          .limit(25),
      ]);
      if (cancelled) return;
      setSnapshot((snap.data as Snapshot | null) ?? null);
      setPositions((pos.data as Position[]) ?? []);
      setOrders((ord.data as Order[]) ?? []);
      setHistory((hist.data as Trade[]) ?? []);
    };
    loadAll();

    const ch = supabase
      .channel(`acct_${selected}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "account_snapshots", filter: `account_id=eq.${selected}` },
        (p) => setSnapshot(p.new as Snapshot),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "positions", filter: `account_id=eq.${selected}` },
        loadAll,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pending_orders", filter: `account_id=eq.${selected}` },
        loadAll,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trade_history", filter: `account_id=eq.${selected}` },
        loadAll,
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, [selected]);

  const acct = useMemo(() => accounts.find((a) => a.id === selected), [accounts, selected]);

  if (!accounts.length) {
    return (
      <div className="rounded-lg border border-border bg-card p-10 text-center">
        <Activity className="h-6 w-6 text-muted-foreground mx-auto" />
        <h2 className="mt-3 text-lg font-medium">No MT5 accounts connected yet</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Add your first account to start streaming live data from your broker.
        </p>
        <Link
          to="/accounts"
          className="mt-5 inline-flex h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium items-center hover:bg-primary/90"
        >
          Connect MT5 account
        </Link>
      </div>
    );
  }

  const currency = snapshot?.currency ?? "USD";
  const fmtMoney = (n: number | null | undefined) =>
    n == null ? "—" : n.toLocaleString(undefined, { style: "currency", currency, maximumFractionDigits: 2 });
  const fmtNum = (n: number | null | undefined, d = 2) =>
    n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: d });

  const connected = acct?.connection_status === "connected";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={selected ?? ""}
            onChange={(e) => setSelected(e.target.value)}
            className="h-9 px-3 rounded-md border border-input bg-card text-sm"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} · #{a.login}
              </option>
            ))}
          </select>
          <span
            className={
              "inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border " +
              (connected
                ? "border-primary/30 bg-primary/5 text-primary"
                : "border-border bg-muted text-muted-foreground")
            }
          >
            {connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
            {acct?.connection_status ?? "unknown"}
            {acct?.last_seen_at ? ` · ${formatDistanceToNow(new Date(acct.last_seen_at))} ago` : ""}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat label="Balance" value={fmtMoney(snapshot?.balance)} />
        <Stat label="Equity" value={fmtMoney(snapshot?.equity)} />
        <Stat label="Profit" value={fmtMoney(snapshot?.profit)} accent={(snapshot?.profit ?? 0) >= 0 ? "pos" : "neg"} />
        <Stat label="Free margin" value={fmtMoney(snapshot?.free_margin)} />
        <Stat label="Used margin" value={fmtMoney(snapshot?.margin)} />
        <Stat label="Margin level" value={snapshot?.margin_level != null ? `${fmtNum(snapshot.margin_level)}%` : "—"} />
      </div>

      <Section title={`Open positions (${positions.length})`}>
        {positions.length === 0 ? (
          <Empty>No open positions.</Empty>
        ) : (
          <Table
            head={["Ticket", "Symbol", "Side", "Vol", "Open", "Current", "SL", "TP", "P/L"]}
            rows={positions.map((p) => [
              p.ticket,
              p.symbol,
              <SideChip key="s" side={p.side} />,
              fmtNum(p.volume, 2),
              fmtNum(p.open_price, 5),
              fmtNum(p.current_price, 5),
              fmtNum(p.stop_loss, 5),
              fmtNum(p.take_profit, 5),
              <span key="pl" className={(p.profit ?? 0) >= 0 ? "text-primary" : "text-destructive"}>
                {fmtMoney(p.profit)}
              </span>,
            ])}
          />
        )}
      </Section>

      <Section title={`Pending orders (${orders.length})`}>
        {orders.length === 0 ? (
          <Empty>No pending orders.</Empty>
        ) : (
          <Table
            head={["Ticket", "Symbol", "Type", "Vol", "Price", "SL", "TP"]}
            rows={orders.map((o) => [
              o.ticket, o.symbol, o.type, fmtNum(o.volume, 2),
              fmtNum(o.price, 5), fmtNum(o.stop_loss, 5), fmtNum(o.take_profit, 5),
            ])}
          />
        )}
      </Section>

      <Section title="Recent trade history">
        {history.length === 0 ? (
          <Empty>No closed trades yet.</Empty>
        ) : (
          <Table
            head={["Ticket", "Symbol", "Side", "Vol", "P/L", "Closed"]}
            rows={history.map((t) => [
              t.ticket, t.symbol, <SideChip key="s" side={t.side} />, fmtNum(t.volume, 2),
              <span key="pl" className={(t.profit ?? 0) >= 0 ? "text-primary" : "text-destructive"}>
                {fmtMoney(t.profit)}
              </span>,
              t.closed_at ? formatDistanceToNow(new Date(t.closed_at)) + " ago" : "—",
            ])}
          />
        )}
      </Section>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: "pos" | "neg" }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={
          "mt-1 text-lg font-semibold tabular-nums " +
          (accent === "pos" ? "text-primary" : accent === "neg" ? "text-destructive" : "text-foreground")
        }
      >
        {value}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="px-4 py-3 border-b border-border text-sm font-medium">{title}</div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-8 text-center text-sm text-muted-foreground">{children}</div>;
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-normal">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border/60 tabular-nums">
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2 whitespace-nowrap">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SideChip({ side }: { side: string }) {
  const up = side.toLowerCase().startsWith("b") || side.toLowerCase() === "long";
  return (
    <span
      className={
        "inline-block px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider " +
        (up ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive")
      }
    >
      {side}
    </span>
  );
}