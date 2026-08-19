// Server-only broker registry: resolves the user's selected broker and returns
// a provider that speaks the broker-independent TradeSignal contract.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { BrokerId, BrokerProvider, TradeSignal } from "./types";

type DB = SupabaseClient<Database>;

export type BrokerContext = {
  broker: BrokerId | null;
  autoTradingEnabled: boolean;
  liveConfirmedAt: string | null;
};

export async function loadBrokerContext(supabase: DB, userId: string): Promise<BrokerContext> {
  const { data } = await supabase
    .from("broker_settings")
    .select("active_broker, auto_trading_enabled, live_confirmed_at")
    .eq("user_id", userId)
    .maybeSingle();
  return {
    broker: (data?.active_broker as BrokerId | null) ?? null,
    autoTradingEnabled: Boolean(data?.auto_trading_enabled),
    liveConfirmedAt: data?.live_confirmed_at ?? null,
  };
}

/** MT5/VPS provider — unchanged behaviour: queue a command for the bridge. */
export function mt5Provider(supabase: DB, userId: string, accountId: string): BrokerProvider {
  return {
    id: "mt5",
    async execute(signal: TradeSignal) {
      const { error } = await supabase.from("bridge_commands").insert({
        user_id: userId,
        account_id: accountId,
        command: "open",
        payload: {
          symbol: signal.symbol,
          side: signal.side,
          volume: signal.volume,
          sl: signal.stop_loss ?? null,
          tp: signal.take_profit ?? null,
          comment: signal.comment ?? "danscom",
        },
      });
      return { ok: !error, reference: null, detail: error?.message ?? "queued for MT5 bridge" };
    },
    async close(positionRef: string) {
      const { error } = await supabase.from("bridge_commands").insert({
        user_id: userId,
        account_id: accountId,
        command: "close",
        payload: { ticket: Number(positionRef) },
      });
      return { ok: !error, reference: null, detail: error?.message ?? "queued for MT5 bridge" };
    },
  };
}

/** Capital.com provider — REST calls scoped to the stored environment. */
export async function capitalProvider(supabase: DB, userId: string): Promise<BrokerProvider> {
  const { getCapitalSession } = await import("@/lib/capital-session.server");
  const cap = await import("@/lib/capital.server");
  const { session, row } = await getCapitalSession(supabase, userId);

  return {
    id: "capital",
    async execute(signal: TradeSignal) {
      const epic = row.gold_epic;
      if (!epic) return { ok: false, reference: null, detail: "GOLD instrument not discovered yet" };
      const r = await cap.openPosition(session, {
        epic,
        direction: signal.side === "sell" ? "SELL" : "BUY",
        size: signal.volume,
        stopLevel: signal.stop_loss ?? null,
        profitLevel: signal.take_profit ?? null,
      });
      const ok = !r.status || r.status === "ACCEPTED";
      return { ok, reference: r.dealReference || null, detail: r.reason ?? r.status };
    },
    async close(positionRef: string) {
      const r = await cap.closePosition(session, positionRef);
      const ok = !r.status || r.status === "ACCEPTED";
      return { ok, reference: r.dealReference || null, detail: r.reason ?? r.status };
    },
  };
}