// Bridge token verification endpoint.
// POST { account_id, bridge_token }  (or Authorization: Bearer <token>)
//  -> 200 { ok: true, ... }   valid
//  -> 401 { ok: false }       invalid token
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const Payload = z.object({
  account_id: z.string().uuid(),
  bridge_token: z.string().min(8).optional(),
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export const Route = createFileRoute("/api/public/bridge/verify")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        const body = await request.json().catch(() => null);
        const parsed = Payload.safeParse(body);
        if (!parsed.success) return json({ ok: false, error: "invalid payload" }, 400);

        const auth = request.headers.get("authorization") ?? "";
        const token = parsed.data.bridge_token ?? (auth.startsWith("Bearer ") ? auth.slice(7) : "");
        if (!token) return json({ ok: false, error: "missing bridge token" }, 401);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: account } = await supabaseAdmin
          .from("mt5_accounts")
          .select("id, broker, connection_status, bridge_token")
          .eq("id", parsed.data.account_id)
          .maybeSingle();

        if (!account || account.bridge_token !== token) {
          return json({ ok: false, error: "invalid account or bridge token" }, 401);
        }
        return json({
          ok: true,
          account_id: account.id,
          broker: account.broker,
          connection_status: account.connection_status,
          server_time: new Date().toISOString(),
        });
      },
    },
  },
});