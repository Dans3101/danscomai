// AI-powered trade confirmation for the MT5 bridge.
// Bridge POSTs current XAUUSD market context; Lovable AI returns a
// bias + confidence. The bridge multiplies this into its own SMC
// confidence score before executing an entry.
import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function authAccount(request: Request, accountId: string) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("mt5_accounts")
    .select("id, bridge_token")
    .eq("id", accountId)
    .maybeSingle();
  if (!data || data.bridge_token !== token) return null;
  return data;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export const Route = createFileRoute("/api/public/bridge/ai-analysis")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        let body: {
          account_id?: string;
          symbol?: string;
          proposed_side?: "buy" | "sell";
          context?: Record<string, unknown>;
        };
        try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
        const accountId = body.account_id ?? "";
        const acct = await authAccount(request, accountId);
        if (!acct) return json({ error: "unauthorized" }, 401);

        const key = process.env.LOVABLE_API_KEY;
        if (!key) return json({ error: "ai unavailable", approve: true, confidence: 80, bias: body.proposed_side ?? "neutral" });

        const sys = `You are a disciplined XAUUSD (gold) trade auditor. Given SMC/technical context, return strict JSON {"bias":"buy"|"sell"|"neutral","confidence":0-100,"reason":"short"}. Approve only if the multi-timeframe read agrees with the proposed side.`;
        const user = `Proposed: ${body.proposed_side ?? "?"} on ${body.symbol ?? "XAUUSD"}\nContext:\n${JSON.stringify(body.context ?? {}, null, 2)}`;

        try {
          const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Lovable-API-Key": key },
            body: JSON.stringify({
              model: "google/gemini-3-flash-preview",
              messages: [
                { role: "system", content: sys },
                { role: "user", content: user },
              ],
              response_format: { type: "json_object" },
            }),
          });
          if (!r.ok) {
            const t = await r.text();
            return json({ error: `ai ${r.status}: ${t}`, approve: false, confidence: 0 }, 200);
          }
          const j = await r.json() as { choices?: { message?: { content?: string } }[] };
          const raw = j.choices?.[0]?.message?.content ?? "{}";
          let parsed: { bias?: string; confidence?: number; reason?: string } = {};
          try { parsed = JSON.parse(raw); } catch { parsed = {}; }
          const bias = parsed.bias ?? "neutral";
          const confidence = Math.max(0, Math.min(100, Number(parsed.confidence ?? 0)));
          const approve = bias === body.proposed_side && confidence >= 60;
          return json({ approve, bias, confidence, reason: parsed.reason ?? "" });
        } catch (e) {
          return json({ error: String(e), approve: false, confidence: 0 }, 200);
        }
      },
    },
  },
});