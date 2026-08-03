// WebSocket discovery endpoint.
//
// The dashboard runs on an edge runtime that terminates plain HTTP only, so the
// persistent Companion WebSocket is served by the Companion Hub on the Ubuntu
// host (wss://<your-host>:8765 or wss://<your-domain>/companion behind nginx).
// This endpoint tells installers and the Windows Companion where to connect and
// never returns the React app.
import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export const Route = createFileRoute("/api/public/bridge/ws")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async ({ request }) => {
        const upgrade = (request.headers.get("upgrade") ?? "").toLowerCase();
        const body = {
          ok: false,
          error: "websocket_not_hosted_here",
          message:
            "The Companion WebSocket is served by the Companion Hub on your Ubuntu host, " +
            "not by the dashboard. Point the Windows Companion at your hub URL.",
          hub: {
            default_port: 8765,
            direct_url_template: "ws://<ubuntu-host>:8765",
            tls_url_template: "wss://<your-domain>/companion",
          },
          http_api: {
            heartbeat: "/api/public/bridge/heartbeat",
            verify: "/api/public/bridge/verify",
            status: "/api/public/bridge/status",
          },
        };
        return json(body, upgrade === "websocket" ? 426 : 501);
      },
    },
  },
});