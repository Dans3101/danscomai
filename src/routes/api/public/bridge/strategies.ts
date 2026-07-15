// Bridge fetches enabled strategies for its account.
// GET (Bearer bridge_token, ?account_id=)
import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function authAccount(request: Request, accountId: string) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("mt5_accounts")
    .select("id, user_id, bridge_token")
    .eq("id", accountId)
    .maybeSingle();
  if (!data || data.bridge_token !== token) return null;
  return data;
}

export const Route = createFileRoute("/api/public/bridge/strategies")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const accountId = url.searchParams.get("account_id") ?? "";
        const acct = await authAccount(request, accountId);
        if (!acct) return json({ error: "unauthorized" }, 401);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin
          .from("strategies")
          .select("id, name, symbol, timeframe, rule_type, rule_params, lot_size, stop_loss_pips, take_profit_pips, trailing_stop_pips, max_daily_loss, max_open_trades, enabled")
          .eq("account_id", accountId)
          .eq("enabled", true);
        if (error) return json({ error: error.message }, 500);
        return json({ strategies: data ?? [] });
      },
    },
  },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}