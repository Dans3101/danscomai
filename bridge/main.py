"""MT5 bridge — streams account state to the dashboard and executes queued
commands.

Run: `python bridge/main.py`

This is the reference implementation. Extend `evaluate_strategies` with your
preferred rules — the app already stores strategy definitions in the
`strategies` table; fetch them via the dashboard's read endpoints or use the
bridge_commands queue for manual actions.
"""

from __future__ import annotations

import os
import sys
import time
import json
import logging
from datetime import datetime, timezone
from typing import Any

import httpx
from dotenv import load_dotenv

load_dotenv()

APP = os.environ["APP_BASE_URL"].rstrip("/")
ACCOUNT_ID = os.environ["ACCOUNT_ID"]
TOKEN = os.environ["BRIDGE_TOKEN"]
LOGIN = int(os.environ["MT5_LOGIN"])
PASSWORD = os.environ["MT5_PASSWORD"]
SERVER = os.environ["MT5_SERVER"]
MT5_PATH = os.environ.get("MT5_PATH") or None
POLL = float(os.environ.get("POLL_SECONDS", "2"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bridge")

HB_URL = f"{APP}/api/public/bridge/heartbeat"
CMD_URL = f"{APP}/api/public/bridge/commands"
HDRS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

try:
    import MetaTrader5 as mt5  # type: ignore
except ImportError:
    log.error("MetaTrader5 module unavailable — this bridge must run on Windows.")
    sys.exit(1)


def iso(ts: float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def connect_mt5() -> bool:
    kwargs: dict[str, Any] = {"login": LOGIN, "password": PASSWORD, "server": SERVER}
    if MT5_PATH:
        kwargs["path"] = MT5_PATH
    if not mt5.initialize(**kwargs):
        log.error("MT5 initialize failed: %s", mt5.last_error())
        return False
    log.info("Connected to MT5 %s @ %s", LOGIN, SERVER)
    return True


def collect_state() -> dict[str, Any]:
    info = mt5.account_info()
    positions = mt5.positions_get() or []
    orders = mt5.orders_get() or []
    # closed trades from the last 24h
    from_ts = datetime.now(timezone.utc).timestamp() - 24 * 3600
    deals = mt5.history_deals_get(from_ts, datetime.now(timezone.utc).timestamp()) or []

    payload: dict[str, Any] = {
        "account_id": ACCOUNT_ID,
        "connection_status": "connected" if info else "error",
    }
    if info:
        payload["snapshot"] = {
            "balance": info.balance,
            "equity": info.equity,
            "margin": info.margin,
            "free_margin": info.margin_free,
            "margin_level": info.margin_level,
            "profit": info.profit,
            "currency": info.currency,
        }
    payload["positions"] = [
        {
            "ticket": p.ticket,
            "symbol": p.symbol,
            "side": "buy" if p.type == mt5.POSITION_TYPE_BUY else "sell",
            "volume": p.volume,
            "open_price": p.price_open,
            "current_price": p.price_current,
            "stop_loss": p.sl or None,
            "take_profit": p.tp or None,
            "swap": p.swap,
            "profit": p.profit,
            "opened_at": iso(p.time),
        }
        for p in positions
    ]
    payload["pending_orders"] = [
        {
            "ticket": o.ticket,
            "symbol": o.symbol,
            "type": _order_type_name(o.type),
            "volume": o.volume_initial,
            "price": o.price_open,
            "stop_loss": o.sl or None,
            "take_profit": o.tp or None,
            "placed_at": iso(o.time_setup),
        }
        for o in orders
    ]
    # Deal-to-trade collapse is broker-specific; ship what we have.
    closed = []
    for d in deals:
        if d.entry != mt5.DEAL_ENTRY_OUT:
            continue
        closed.append({
            "ticket": d.position_id or d.ticket,
            "symbol": d.symbol,
            "side": "buy" if d.type == mt5.DEAL_TYPE_BUY else "sell",
            "volume": d.volume,
            "close_price": d.price,
            "profit": d.profit,
            "swap": d.swap,
            "commission": d.commission,
            "closed_at": iso(d.time),
        })
    payload["closed_trades"] = closed
    return payload


def _order_type_name(t: int) -> str:
    mapping = {
        mt5.ORDER_TYPE_BUY: "buy",
        mt5.ORDER_TYPE_SELL: "sell",
        mt5.ORDER_TYPE_BUY_LIMIT: "buy_limit",
        mt5.ORDER_TYPE_SELL_LIMIT: "sell_limit",
        mt5.ORDER_TYPE_BUY_STOP: "buy_stop",
        mt5.ORDER_TYPE_SELL_STOP: "sell_stop",
    }
    return mapping.get(t, str(t))


def execute_command(cmd: dict[str, Any]) -> dict[str, Any]:
    """Execute one queued command. Extend as needed."""
    name = cmd["command"]
    p = cmd.get("payload") or {}
    if name == "ping":
        return {"pong": True}
    if name == "open":
        return _order_send(p)
    if name == "close":
        return _close_position(int(p["ticket"]))
    if name == "close_all":
        return _close_all()
    if name == "modify":
        return _modify_position(int(p["ticket"]), p.get("sl"), p.get("tp"))
    return {"error": f"unknown command {name}"}


def _order_send(p: dict[str, Any]) -> dict[str, Any]:
    symbol = p["symbol"]
    side = p["side"].lower()
    volume = float(p["volume"])
    mt5.symbol_select(symbol, True)
    tick = mt5.symbol_info_tick(symbol)
    price = tick.ask if side == "buy" else tick.bid
    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL,
        "price": price,
        "sl": float(p.get("sl") or 0),
        "tp": float(p.get("tp") or 0),
        "deviation": 20,
        "magic": 424242,
        "comment": p.get("comment", "autotrader"),
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    r = mt5.order_send(req)
    return {"retcode": r.retcode, "order": r.order, "deal": r.deal, "comment": r.comment}


def _close_position(ticket: int) -> dict[str, Any]:
    pos = mt5.positions_get(ticket=ticket)
    if not pos:
        return {"error": "not found"}
    pos = pos[0]
    tick = mt5.symbol_info_tick(pos.symbol)
    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "position": pos.ticket,
        "symbol": pos.symbol,
        "volume": pos.volume,
        "type": mt5.ORDER_TYPE_SELL if pos.type == mt5.POSITION_TYPE_BUY else mt5.ORDER_TYPE_BUY,
        "price": tick.bid if pos.type == mt5.POSITION_TYPE_BUY else tick.ask,
        "deviation": 20,
        "magic": 424242,
        "comment": "autotrader-close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    r = mt5.order_send(req)
    return {"retcode": r.retcode, "comment": r.comment}


def _close_all() -> dict[str, Any]:
    positions = mt5.positions_get() or []
    return {"closed": [_close_position(p.ticket) for p in positions]}


def _modify_position(ticket: int, sl: Any, tp: Any) -> dict[str, Any]:
    pos = mt5.positions_get(ticket=ticket)
    if not pos:
        return {"error": "not found"}
    pos = pos[0]
    req = {
        "action": mt5.TRADE_ACTION_SLTP,
        "position": pos.ticket,
        "symbol": pos.symbol,
        "sl": float(sl or pos.sl or 0),
        "tp": float(tp or pos.tp or 0),
    }
    r = mt5.order_send(req)
    return {"retcode": r.retcode, "comment": r.comment}


def evaluate_strategies() -> None:
    """Placeholder for autonomous rule evaluation.

    Suggested implementation: fetch the user's strategies once per minute
    (extend the app with a bridge-scoped endpoint or embed rules in
    bridge_commands), evaluate them against the latest candles from
    `mt5.copy_rates_from_pos`, apply risk gates (daily loss, max open trades),
    then submit `open` / `close` commands.
    """
    return


def post_heartbeat(client: httpx.Client, payload: dict[str, Any]) -> None:
    try:
        r = client.post(HB_URL, headers=HDRS, json=payload, timeout=10)
        if r.status_code >= 400:
            log.warning("heartbeat %s: %s", r.status_code, r.text)
    except Exception as e:
        log.warning("heartbeat error: %s", e)


def poll_commands(client: httpx.Client) -> None:
    try:
        r = client.get(CMD_URL, headers=HDRS, params={"account_id": ACCOUNT_ID}, timeout=10)
        if r.status_code >= 400:
            log.warning("commands %s: %s", r.status_code, r.text)
            return
        for cmd in r.json().get("commands", []):
            log.info("executing %s", cmd["command"])
            result = execute_command(cmd)
            client.post(
                CMD_URL,
                headers=HDRS,
                json={
                    "account_id": ACCOUNT_ID,
                    "command_id": cmd["id"],
                    "status": "failed" if isinstance(result, dict) and result.get("error") else "done",
                    "result": result,
                },
                timeout=10,
            )
    except Exception as e:
        log.warning("commands error: %s", e)


def main() -> None:
    while not connect_mt5():
        log.info("Retrying MT5 connect in 5s…")
        time.sleep(5)

    with httpx.Client() as client:
        while True:
            try:
                post_heartbeat(client, collect_state())
                poll_commands(client)
                evaluate_strategies()
            except Exception as e:
                log.exception("loop error: %s", e)
                # Try to reconnect on hard failure.
                mt5.shutdown()
                while not connect_mt5():
                    time.sleep(5)
            time.sleep(POLL)


if __name__ == "__main__":
    main()