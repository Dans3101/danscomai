// Bridge status endpoint.
// GET /api/public/bridge/status                      -> API health (no auth)
// GET /api/public/bridge/status?account_id=<uuid>    -> account status (Bearer token)
import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });
}

export const Route = createFileRoute("/api/public/bridge/status")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const accountId = url.searchParams.get("account_id");
        const now = new Date().toISOString();

        if (!accountId) {
          return json({
            ok: true,
            service: "mt5-bridge-api",
            server_time: now,
            endpoints: [
              "GET  /api/public/bridge/heartbeat",
              "POST /api/public/bridge/heartbeat",
              "POST /api/public/bridge/verify",
              "GET  /api/public/bridge/status",
              "GET  /api/public/bridge/ws",
              "GET  /api/public/bridge/strategies",
              "GET  /api/public/bridge/commands",
              "POST /api/public/bridge/service-logs",
            ],
          });
        }

        const auth = request.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token) return json({ ok: false, error: "missing bearer" }, 401);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: account } = await supabaseAdmin
          .from("mt5_accounts")
          .select("id, broker_name, server, connection_status, last_seen_at, bridge_token")
          .eq("id", accountId)
          .maybeSingle();
        if (!account || account.bridge_token !== token) {
          return json({ ok: false, error: "invalid account or bridge token" }, 401);
        }

        const { data: snapshot } = await supabaseAdmin
          .from("account_snapshots")
          .select("balance, equity, free_margin, margin_level, profit, currency, created_at")
          .eq("account_id", account.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const { count: openPositions } = await supabaseAdmin
          .from("positions")
          .select("id", { count: "exact", head: true })
          .eq("account_id", account.id);

        const lastSeen = account.last_seen_at ? new Date(account.last_seen_at).getTime() : 0;
        const stale = !lastSeen || Date.now() - lastSeen > 90_000;

        return json({
          ok: true,
          server_time: now,
          account: {
            id: account.id,
            broker_name: account.broker_name,
            server: account.server,
            connection_status: stale ? "stale" : account.connection_status,
            last_seen_at: account.last_seen_at,
          },
          snapshot: snapshot ?? null,
          open_positions: openPositions ?? 0,
        });
      },
    },
  },
});