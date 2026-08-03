"""Windows Companion Service.

Runs MT5 natively on Windows for up to 3 accounts and keeps ONE persistent,
auto-reconnecting WebSocket (TLS) open to the Ubuntu backend hub. All trade
commands arrive over that socket; all account state, positions, orders and
execution results are pushed back over it.

Run:  python companion.py            (reads config.json next to this file)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import ssl
import sys
import time
from pathlib import Path
from typing import Any

import websockets

import protocol as P
import secure_store
from mt5_worker import AccountWorker

HERE = Path(__file__).parent
CONFIG_DIR = Path(os.environ.get("COMPANION_CONFIG_DIR", HERE))


def load_config() -> dict[str, Any]:
    """DPAPI-protected config.secure.json (installer) or plain config.json (dev)."""
    cfg = secure_store.load(CONFIG_DIR)
    accounts = cfg.get("accounts") or []
    if not accounts:
        raise SystemExit("config.accounts is empty")
    if len(accounts) > P.MAX_ACCOUNTS:
        raise SystemExit(f"phase 1 supports at most {P.MAX_ACCOUNTS} MT5 accounts")
    for a in accounts:
        for field in ("account_id", "login", "password", "server"):
            if not a.get(field):
                raise SystemExit(f"account {a.get('account_id', '?')} missing '{field}'")
    return cfg


CFG = load_config()
os.environ.setdefault("LOG_LEVEL", str(CFG.get("log_level", "INFO")).upper())
os.environ.setdefault("LOG_DIR", str(Path(__file__).resolve().parent / "logs"))
import logging_setup  # noqa: E402

log = logging_setup.setup("companion")
_last_log_ship = 0.0
LOG_SHIP_SECONDS = float(CFG.get("log_ship_seconds", 60))

BACKEND_WS = str(CFG["backend_ws_url"]).rstrip("/")
BRIDGE_TOKEN = str(CFG["bridge_token"])
NAME = str(CFG.get("name") or os.environ.get("COMPUTERNAME") or "companion")
HEALTH_SECONDS = float(CFG.get("health_seconds", 10))
MAX_BACKOFF = float(CFG.get("max_reconnect_seconds", 60))
VERIFY_TLS = bool(CFG.get("verify_tls", True))

WORKERS: dict[str, AccountWorker] = {}


def start_workers() -> None:
    for a in CFG["accounts"]:
        w = AccountWorker({
            "account_id": str(a["account_id"]),
            "login": int(a["login"]),
            "password": str(a["password"]),
            "server": str(a["server"]),
            "terminal_path": a.get("terminal_path") or CFG.get("terminal_path"),
            "portable": bool(a.get("portable", False)),
            "log_level": str(CFG.get("log_level", "INFO")).upper(),
        })
        w.start()
        WORKERS[w.account_id] = w


def _ssl_context() -> ssl.SSLContext | None:
    if not BACKEND_WS.startswith("wss://"):
        return None
    ctx = ssl.create_default_context()
    if not VERIFY_TLS:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    ca = CFG.get("tls_ca_file")
    if ca:
        ctx.load_verify_locations(ca)
    return ctx


async def pump_worker_results(ws) -> None:
    """Forward worker replies/status to the backend; keep workers alive."""
    global _last_log_ship
    last_health = 0.0
    while True:
        for w in WORKERS.values():
            w.ensure_alive()
            for msg in w.drain():
                kind = msg.get("kind")
                if kind == "result":
                    await ws.send(json.dumps({
                        "type": P.RESULT, "id": msg.get("id"),
                        "ok": msg.get("ok"), "result": msg.get("result"),
                        "error": msg.get("error"),
                    }))
                elif kind == "status":
                    w.status = {k: msg.get(k) for k in ("connected", "terminal", "error")}
                    await ws.send(json.dumps({
                        "type": P.STATUS, "account_id": w.account_id, **w.status,
                    }))
                elif kind == "constants":
                    w.constants = msg.get("data") or {}

        now = time.time()
        if now - last_health >= HEALTH_SECONDS:
            last_health = now
            for w in WORKERS.values():
                w.submit({"kind": "healthcheck"})
        if now - _last_log_ship >= LOG_SHIP_SECONDS:
            window = max(LOG_SHIP_SECONDS * 2, 120)
            entries = logging_setup.recent_errors(window)
            _last_log_ship = now
            if entries:
                await ws.send(json.dumps({"type": "log", "entries": entries[:100]}))
        await asyncio.sleep(0.05)


async def handle_backend(ws) -> None:
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        t = msg.get("type")
        if t == P.CALL:
            account_id = str(msg.get("account_id"))
            w = WORKERS.get(account_id)
            if w is None:
                await ws.send(json.dumps({
                    "type": P.RESULT, "id": msg.get("id"), "ok": False,
                    "error": f"unknown account {account_id}",
                }))
                continue
            w.ensure_alive()
            w.submit({"kind": "call", "id": msg.get("id"), "fn": msg.get("fn"),
                      "args": msg.get("args") or [], "kwargs": msg.get("kwargs") or {}})
        elif t == P.PING:
            await ws.send(json.dumps({"type": P.PONG, "ts": time.time()}))
        elif t == P.WELCOME:
            log.info("backend accepted accounts: %s", msg.get("accounts"))
        elif t == P.ERROR:
            log.error("backend error: %s", msg.get("message"))


def hello_payload() -> dict[str, Any]:
    constants: dict[str, int] = {}
    for w in WORKERS.values():
        constants.update(w.constants)
    return {
        "type": P.HELLO,
        "version": P.PROTOCOL_VERSION,
        "token": BRIDGE_TOKEN,
        "companion": NAME,
        "constants": constants,
        "accounts": [
            {"account_id": w.account_id, "login": w.cfg["login"], "server": w.cfg["server"]}
            for w in WORKERS.values()
        ],
    }


async def session_once() -> None:
    ctx = _ssl_context()
    log.info("connecting to backend %s", BACKEND_WS)
    async with websockets.connect(
        BACKEND_WS, ssl=ctx, ping_interval=20, ping_timeout=40,
        max_size=8 * 1024 * 1024, open_timeout=20,
    ) as ws:
        await ws.send(json.dumps(hello_payload()))
        log.info("connected — %d account(s) online", len(WORKERS))
        pump = asyncio.create_task(pump_worker_results(ws))
        try:
            await handle_backend(ws)
        finally:
            pump.cancel()


async def main() -> None:
    start_workers()
    # Give the workers a moment to publish their MT5 constants.
    await asyncio.sleep(2)
    for w in WORKERS.values():
        for msg in w.drain():
            if msg.get("kind") == "constants":
                w.constants = msg.get("data") or {}

    delay = 2.0
    while True:
        try:
            await session_once()
            delay = 2.0
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("backend link down (%s) — retrying in %.0fs", e, delay)
        else:
            log.warning("backend closed the link — retrying in %.0fs", delay)
        await asyncio.sleep(delay)
        delay = min(delay * 2, MAX_BACKOFF)


if __name__ == "__main__":
    if sys.platform != "win32":
        log.warning("this service is designed for Windows (native MetaTrader5 package)")
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    finally:
        for w in WORKERS.values():
            w.stop()