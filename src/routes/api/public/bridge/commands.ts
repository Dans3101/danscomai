// Bridge polls this endpoint for pending commands and posts results back.
// GET  -> list pending commands for the account (Bearer bridge_token, ?account_id=)
// POST -> mark a command as completed with result (Bearer bridge_token)
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

export const Route = createFileRoute("/api/public/bridge/commands")({
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
          .from("bridge_commands")
          .select("id, command, payload, created_at")
          .eq("account_id", accountId)
          .eq("status", "pending")
          .order("created_at", { ascending: true })
          .limit(20);
        if (error) return json({ error: error.message }, 500);
        return json({ commands: data ?? [] });
      },
      POST: async ({ request }) => {
        const body = await request.json().catch(() => null);
        const parsed = z
          .object({
            account_id: z.string().uuid(),
            command_id: z.string().uuid(),
            status: z.enum(["done", "failed"]),
            result: z.any().optional(),
          })
          .safeParse(body);
        if (!parsed.success) return json({ error: "invalid" }, 400);
        const acct = await authAccount(request, parsed.data.account_id);
        if (!acct) return json({ error: "unauthorized" }, 401);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        await supabaseAdmin
          .from("bridge_commands")
          .update({
            status: parsed.data.status,
            result: parsed.data.result ?? null,
            processed_at: new Date().toISOString(),
          })
          .eq("id", parsed.data.command_id)
          .eq("account_id", parsed.data.account_id);
        return json({ ok: true });
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