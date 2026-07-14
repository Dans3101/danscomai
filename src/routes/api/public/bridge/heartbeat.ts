// Bridge -> platform ingestion endpoint.
// Auth: Bearer <account.bridge_token>. Bypasses user auth; each account has
// its own opaque token minted at account creation. The bridge posts account
// snapshots, positions, orders, and closed trades here.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const Payload = z.object({
  account_id: z.string().uuid(),
  connection_status: z.enum(["connected", "disconnected", "error"]).optional(),
  snapshot: z
    .object({
      balance: z.number().nullable().optional(),
      equity: z.number().nullable().optional(),
      margin: z.number().nullable().optional(),
      free_margin: z.number().nullable().optional(),
      margin_level: z.number().nullable().optional(),
      profit: z.number().nullable().optional(),
      currency: z.string().nullable().optional(),
    })
    .optional(),
  positions: z
    .array(
      z.object({
        ticket: z.number(),
        symbol: z.string(),
        side: z.string(),
        volume: z.number(),
        open_price: z.number().nullable().optional(),
        current_price: z.number().nullable().optional(),
        stop_loss: z.number().nullable().optional(),
        take_profit: z.number().nullable().optional(),
        swap: z.number().nullable().optional(),
        profit: z.number().nullable().optional(),
        opened_at: z.string().nullable().optional(),
      }),
    )
    .optional(),
  pending_orders: z
    .array(
      z.object({
        ticket: z.number(),
        symbol: z.string(),
        type: z.string(),
        volume: z.number(),
        price: z.number().nullable().optional(),
        stop_loss: z.number().nullable().optional(),
        take_profit: z.number().nullable().optional(),
        placed_at: z.string().nullable().optional(),
      }),
    )
    .optional(),
  closed_trades: z
    .array(
      z.object({
        ticket: z.number(),
        symbol: z.string(),
        side: z.string(),
        volume: z.number(),
        open_price: z.number().nullable().optional(),
        close_price: z.number().nullable().optional(),
        profit: z.number().nullable().optional(),
        swap: z.number().nullable().optional(),
        commission: z.number().nullable().optional(),
        opened_at: z.string().nullable().optional(),
        closed_at: z.string().nullable().optional(),
      }),
    )
    .optional(),
  logs: z
    .array(
      z.object({
        level: z.enum(["info", "warn", "error"]).default("info"),
        source: z.string().default("bridge"),
        message: z.string(),
        data: z.any().optional(),
      }),
    )
    .optional(),
});

export const Route = createFileRoute("/api/public/bridge/heartbeat")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        const auth = request.headers.get("authorization") ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token) return json({ error: "missing bearer" }, 401);

        const body = await request.json().catch(() => null);
        const parsed = Payload.safeParse(body);
        if (!parsed.success) return json({ error: "invalid payload", details: parsed.error.flatten() }, 400);
        const p = parsed.data;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: account, error: acctErr } = await supabaseAdmin
          .from("mt5_accounts")
          .select("id, user_id, bridge_token")
          .eq("id", p.account_id)
          .maybeSingle();
        if (acctErr || !account) return json({ error: "unknown account" }, 404);
        if (account.bridge_token !== token) return json({ error: "bad token" }, 401);
        const userId = account.user_id;

        await supabaseAdmin
          .from("mt5_accounts")
          .update({
            last_seen_at: new Date().toISOString(),
            connection_status: p.connection_status ?? "connected",
          })
          .eq("id", account.id);

        if (p.snapshot) {
          await supabaseAdmin.from("account_snapshots").insert({
            user_id: userId,
            account_id: account.id,
            ...p.snapshot,
          });
        }

        if (p.positions) {
          // Replace-all strategy for open positions.
          await supabaseAdmin.from("positions").delete().eq("account_id", account.id);
          if (p.positions.length) {
            await supabaseAdmin.from("positions").insert(
              p.positions.map((pos) => ({
                user_id: userId,
                account_id: account.id,
                ...pos,
              })),
            );
          }
        }

        if (p.pending_orders) {
          await supabaseAdmin.from("pending_orders").delete().eq("account_id", account.id);
          if (p.pending_orders.length) {
            await supabaseAdmin.from("pending_orders").insert(
              p.pending_orders.map((o) => ({ user_id: userId, account_id: account.id, ...o })),
            );
          }
        }

        if (p.closed_trades && p.closed_trades.length) {
          await supabaseAdmin
            .from("trade_history")
            .upsert(
              p.closed_trades.map((t) => ({ user_id: userId, account_id: account.id, ...t })),
              { onConflict: "account_id,ticket" },
            );
        }

        if (p.logs && p.logs.length) {
          await supabaseAdmin.from("activity_logs").insert(
            p.logs.map((l) => ({ user_id: userId, account_id: account.id, ...l })),
          );
        }

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