// Centralized service log ingestion for the Companion Hub and the Windows
// Companion. Auth: Bearer <account.bridge_token>.
//   POST { account_id, entries: [{ level, source, message, data, ts }] }
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
  entries: z
    .array(
      z.object({
        level: z.enum(["info", "warn", "error"]).default("info"),
        source: z.enum(["hub", "companion", "bridge"]).default("hub"),
        message: z.string().max(4000),
        data: z.any().optional(),
        ts: z.string().optional(),
      }),
    )
    .max(200),
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export const Route = createFileRoute("/api/public/bridge/service-logs")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const headerToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const parsed = Payload.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return json({ ok: false, error: "invalid payload" }, 400);
        const token = parsed.data.bridge_token ?? headerToken;
        if (!token) return json({ ok: false, error: "missing bearer" }, 401);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: account } = await supabaseAdmin
          .from("mt5_accounts")
          .select("id, user_id, bridge_token")
          .eq("id", parsed.data.account_id)
          .maybeSingle();
        if (!account || account.bridge_token !== token) {
          return json({ ok: false, error: "invalid account or bridge token" }, 401);
        }

        if (parsed.data.entries.length) {
          await supabaseAdmin.from("activity_logs").insert(
            parsed.data.entries.map((e) => ({
              user_id: account.user_id,
              account_id: account.id,
              level: e.level,
              source: e.source,
              message: e.message,
              data: e.data ?? null,
            })),
          );
        }
        return json({ ok: true, stored: parsed.data.entries.length });
      },
    },
  },
});