"""Single-process entrypoint for deploying the MT5 trading engine on Render.

Runs BOTH services inside one container:

  * companion hub  — terminates the Windows Companion's persistent WebSocket
                     on the Render-assigned $PORT (TLS is terminated by
                     Render's edge, so no certificates are needed here)
  * bridge worker  — the main.py loop: pulls strategy config from the
                     dashboard backend, evaluates the SMC confluence engine,
                     routes orders to the Windows Companion, and streams
                     account snapshots / heartbeats / logs back to it

Render is deliberately STATELESS in this setup:
  * no database, no persistent disk, no durable files
  * logs, health files and metrics stay in memory or /tmp (ephemeral)
  * every durable artifact (account snapshots, positions, trade history,
    strategies, service logs) lives in the dashboard backend (Lovable Cloud)

Its single purpose is to run the automated-trading logic for ONE bot
(XAUUSD) and relay execution to the Windows VPS Companion, exactly as the
Ubuntu deployment does.

Run:  python bridge/render_server.py
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import threading
from pathlib import Path

BRIDGE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BRIDGE_DIR))

import companion_hub as hub  # noqa: E402

WS_HOST = os.environ.get("HUB_HOST", "0.0.0.0")
PING_INTERVAL = float(os.environ.get("HUB_PING_INTERVAL", "20"))


def _port() -> int:
    """Render injects PORT; fall back to HUB_WS_PORT for local testing."""
    raw = os.environ.get("PORT") or os.environ.get("HUB_WS_PORT") or "8765"
    return int(raw)


def _check_required_env() -> None:
    missing = [k for k in ("APP_BASE_URL", "ACCOUNT_ID", "BRIDGE_TOKEN")
               if not os.environ.get(k)]
    if missing:
        print(
            "missing required environment variables: " + ", ".join(missing) +
            " — set them in the Render dashboard (see render.yaml / README)",
            flush=True,
        )
        sys.exit(1)


def _http_process_request(connection, request):
    """Answer plain HTTP probes on the WebSocket port.

    Render's health checks and uptime monitors send plain GET requests; the
    websockets library lets us intercept them before the upgrade handshake.
    """
    if (request.headers.get("Upgrade") or "").lower() == "websocket":
        return None  # normal Companion WebSocket handshake — continue
    path = request.path.split("?", 1)[0]
    if path in ("/health", "/healthz", "/ping", "/"):
        body = json.dumps({
            "ok": True,
            "service": "mt5-render-engine",
            "companions": len(hub.REG.sessions),
        }).encode()
        return connection.respond(200, body.decode())
    if path == "/status":
        body = json.dumps({"ok": True, **hub.REG.snapshot()}).encode()
        return connection.respond(200, body.decode())
    return connection.respond(404, '{"ok": false, "error": "not found"}')


def _run_worker() -> None:
    """Run the trading loop (blocking forever) on a side thread."""
    import main as worker  # imported lazily so env validation runs first

    try:
        worker.main()
    except Exception:  # noqa: BLE001
        # The worker crashes hard only if reconnects fail permanently; Render
        # restarts the whole service in that case (the hub dies with it, and
        # the Windows Companion reconnects automatically).
        import traceback
        traceback.print_exc()
        os._exit(1)


async def _serve() -> None:
    hub.LOOP = asyncio.get_running_loop()
    hub.start_rpc_server()

    threading.Thread(target=_run_worker, name="bridge-worker", daemon=True).start()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # pragma: no cover
            pass

    port = _port()
    hub.log.info(
        "render engine listening — ws port=%s rpc=127.0.0.1:%s stateless=on",
        port, hub.RPC_PORT,
    )
    async with __import__("websockets").serve(
        hub.ws_handler, WS_HOST, port,
        process_request=_http_process_request,
        ping_interval=PING_INTERVAL, ping_timeout=PING_INTERVAL * 2,
        max_size=8 * 1024 * 1024,
    ):
        await stop.wait()


if __name__ == "__main__":
    _check_required_env()
    try:
        asyncio.run(_serve())
    except KeyboardInterrupt:
        pass
