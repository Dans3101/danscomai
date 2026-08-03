"""Ubuntu-side Companion Hub.

Terminates the persistent WebSocket connection opened by the Windows
Companion Service and exposes a small loopback JSON-RPC endpoint that the
bridge workers (`main.py` via `remote_mt5.py`) call synchronously.

    Windows Companion ──wss──▶ companion_hub ──127.0.0.1:8766──▶ bridge worker(s)

Run:  python bridge/companion_hub.py

Environment:
    HUB_HOST           bind address for the WebSocket server (default 0.0.0.0)
    HUB_WS_PORT        WebSocket port (default 8765)
    HUB_RPC_HOST       loopback RPC bind (default 127.0.0.1)
    HUB_RPC_PORT       loopback RPC port (default 8766)
    COMPANION_TOKENS   comma-separated accepted bridge tokens
                       (falls back to BRIDGE_TOKEN)
    HUB_TLS_CERT/KEY   optional; omit when TLS is terminated by nginx/caddy
    RPC_TIMEOUT        seconds to wait for a Companion reply (default 30)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import ssl
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Any

from dotenv import load_dotenv
import websockets

import protocol as P

load_dotenv()

import logging_setup

log = logging_setup.setup("hub")

# Warnings/errors reported by connected Windows Companions (last 24h).
COMPANION_LOGS: list[dict[str, Any]] = []

HUB_HOST = os.environ.get("HUB_HOST", "0.0.0.0")
HUB_WS_PORT = int(os.environ.get("HUB_WS_PORT", "8765"))
RPC_HOST = os.environ.get("HUB_RPC_HOST", "127.0.0.1")
RPC_PORT = int(os.environ.get("HUB_RPC_PORT", "8766"))
RPC_TIMEOUT = float(os.environ.get("RPC_TIMEOUT", "30"))
PING_INTERVAL = float(os.environ.get("HUB_PING_INTERVAL", "20"))

_tokens_raw = os.environ.get("COMPANION_TOKENS") or os.environ.get("BRIDGE_TOKEN", "")
TOKENS = {t.strip() for t in _tokens_raw.split(",") if t.strip()}


class Session:
    """One connected Windows Companion."""

    def __init__(self, ws, name: str, accounts: list[dict[str, Any]], constants: dict[str, int]):
        self.ws = ws
        self.name = name
        self.accounts = {str(a["account_id"]): a for a in accounts}
        self.constants = constants or dict(P.MT5_CONSTANTS)
        self.status: dict[str, dict[str, Any]] = {}
        self.connected_at = time.time()
        self.last_seen = time.time()
        self._seq = 0
        self._waiters: dict[int, asyncio.Future] = {}

    def next_id(self) -> int:
        self._seq += 1
        return self._seq

    async def call(self, account_id: str, fn: str, args: list, kwargs: dict) -> Any:
        if fn not in P.ALLOWED_FUNCTIONS:
            raise ValueError(f"function not allowed: {fn}")
        rid = self.next_id()
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._waiters[rid] = fut
        await self.ws.send(json.dumps({
            "type": P.CALL, "id": rid, "account_id": account_id,
            "fn": fn, "args": args, "kwargs": kwargs,
        }))
        try:
            return await asyncio.wait_for(fut, RPC_TIMEOUT)
        finally:
            self._waiters.pop(rid, None)

    def resolve(self, msg: dict[str, Any]) -> None:
        fut = self._waiters.get(int(msg.get("id", -1)))
        if fut and not fut.done():
            if msg.get("ok"):
                fut.set_result(msg.get("result"))
            else:
                fut.set_exception(RuntimeError(str(msg.get("error") or "companion error")))

    def fail_all(self, reason: str) -> None:
        for fut in list(self._waiters.values()):
            if not fut.done():
                fut.set_exception(RuntimeError(reason))
        self._waiters.clear()


class Registry:
    """account_id -> Session mapping, shared between the WS and RPC servers."""

    def __init__(self) -> None:
        self.sessions: list[Session] = []

    def add(self, s: Session) -> None:
        self.sessions.append(s)

    def remove(self, s: Session) -> None:
        if s in self.sessions:
            self.sessions.remove(s)

    def for_account(self, account_id: str) -> Session | None:
        for s in self.sessions:
            if account_id in s.accounts:
                return s
        return None

    def snapshot(self) -> dict[str, Any]:
        return {
            "companions": [
                {
                    "name": s.name,
                    "connected_at": s.connected_at,
                    "last_seen": s.last_seen,
                    "accounts": list(s.accounts.keys()),
                    "status": s.status,
                }
                for s in self.sessions
            ],
        }


REG = Registry()
LOOP: asyncio.AbstractEventLoop | None = None


async def ws_handler(ws) -> None:
    peer = getattr(ws, "remote_address", ("?", 0))
    session: Session | None = None
    try:
        raw = await asyncio.wait_for(ws.recv(), 15)
        hello = json.loads(raw)
        if hello.get("type") != P.HELLO:
            await ws.send(json.dumps({"type": P.ERROR, "message": "expected hello"}))
            return
        if TOKENS and hello.get("token") not in TOKENS:
            log.warning("rejected companion from %s: bad token", peer)
            await ws.send(json.dumps({"type": P.ERROR, "message": "unauthorized"}))
            return

        accounts = list(hello.get("accounts") or [])[: P.MAX_ACCOUNTS]
        session = Session(ws, str(hello.get("companion") or "companion"), accounts,
                          hello.get("constants") or {})
        REG.add(session)
        log.info("companion %s connected from %s accounts=%s",
                 session.name, peer, list(session.accounts))
        await ws.send(json.dumps({"type": P.WELCOME, "accounts": list(session.accounts)}))

        async for raw in ws:
            session.last_seen = time.time()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            t = msg.get("type")
            if t == P.RESULT:
                session.resolve(msg)
            elif t == P.STATUS:
                session.status[str(msg.get("account_id"))] = msg
            elif t == "log":
                for e in (msg.get("entries") or [])[:100]:
                    COMPANION_LOGS.append({
                        "ts": float(e.get("ts") or time.time()),
                        "ts_iso": e.get("ts_iso"),
                        "level": e.get("level", "error"),
                        "service": "companion",
                        "message": str(e.get("message", ""))[:4000],
                    })
                del COMPANION_LOGS[:-2000]
            elif t == P.PING:
                await ws.send(json.dumps({"type": P.PONG, "ts": time.time()}))
    except asyncio.TimeoutError:
        log.warning("handshake timeout from %s", peer)
    except websockets.ConnectionClosed:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("ws handler error: %s", e)
    finally:
        if session:
            session.fail_all("companion disconnected")
            REG.remove(session)
            log.warning("companion %s disconnected", session.name)


class RPCHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_a):  # silence per-request stdout noise
        pass

    def _send(self, body: dict[str, Any], status: int = 200) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/status"):
            self._send({"ok": True, **REG.snapshot()})
        elif self.path.startswith("/logs"):
            cutoff = time.time() - 24 * 3600
            entries = [
                {**e, "service": "hub", "ts_iso": e.get("ts_iso")}
                for e in logging_setup.recent_errors()
            ] + [e for e in COMPANION_LOGS if e["ts"] >= cutoff]
            entries.sort(key=lambda e: e["ts"], reverse=True)
            self._send({"ok": True, "entries": entries[:500]})
        elif self.path.startswith("/health"):
            self._send({"ok": True, "companions": len(REG.sessions)})
        else:
            self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send({"ok": False, "error": "bad json"}, 400)
            return

        if self.path.startswith("/constants"):
            s = REG.for_account(str(req.get("account_id")))
            self._send({"ok": True, "constants": s.constants if s else dict(P.MT5_CONSTANTS)})
            return
        if not self.path.startswith("/rpc"):
            self._send({"ok": False, "error": "not found"}, 404)
            return

        account_id = str(req.get("account_id") or "")
        session = REG.for_account(account_id)
        if session is None:
            self._send({"ok": False, "error": "no companion for account", "offline": True}, 503)
            return
        try:
            fut = asyncio.run_coroutine_threadsafe(
                session.call(account_id, str(req.get("fn")),
                             list(req.get("args") or []), dict(req.get("kwargs") or {})),
                LOOP,  # type: ignore[arg-type]
            )
            self._send({"ok": True, "result": fut.result(RPC_TIMEOUT + 5)})
        except Exception as e:  # noqa: BLE001
            self._send({"ok": False, "error": str(e)}, 502)


def start_rpc_server() -> ThreadingHTTPServer:
    srv = ThreadingHTTPServer((RPC_HOST, RPC_PORT), RPCHandler)
    srv.daemon_threads = True
    Thread(target=srv.serve_forever, daemon=True, name="hub-rpc").start()
    log.info("loopback RPC listening on http://%s:%s", RPC_HOST, RPC_PORT)
    return srv


def _tls_context() -> ssl.SSLContext | None:
    cert = os.environ.get("HUB_TLS_CERT")
    key = os.environ.get("HUB_TLS_KEY")
    if not (cert and key):
        return None
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


async def main() -> None:
    global LOOP
    LOOP = asyncio.get_running_loop()
    start_rpc_server()
    ctx = _tls_context()
    log.info("companion hub listening on ws%s://%s:%s (tokens=%d)",
             "s" if ctx else "", HUB_HOST, HUB_WS_PORT, len(TOKENS))
    async with websockets.serve(
        ws_handler, HUB_HOST, HUB_WS_PORT, ssl=ctx,
        ping_interval=PING_INTERVAL, ping_timeout=PING_INTERVAL * 2,
        max_size=8 * 1024 * 1024,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass