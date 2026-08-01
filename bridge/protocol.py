"""Wire protocol shared by the Ubuntu hub and the Windows Companion.

Transport: a single persistent WebSocket (TLS in production) initiated by the
Windows Companion towards the Ubuntu backend. The Companion is always the
client, so the Windows host needs no inbound ports.

Message envelope (JSON, one object per WS frame):

  Companion -> hub
    {"type": "hello",  "token": "...", "companion": "name",
     "accounts": [{"account_id": "...", "login": 123, "server": "..."}],
     "constants": {"ORDER_TYPE_BUY": 0, ...}}
    {"type": "status", "account_id": "...", "connected": true,
     "terminal": "running", "error": null}
    {"type": "result", "id": 7, "ok": true, "result": ...}
    {"type": "pong",   "ts": 1699999999.0}

  hub -> Companion
    {"type": "welcome", "accounts": ["..."]}
    {"type": "call", "id": 7, "account_id": "...", "fn": "account_info",
     "args": [], "kwargs": {}}
    {"type": "ping", "ts": 1699999999.0}
    {"type": "error", "message": "..."}

All MT5 return values are normalised to plain JSON (namedtuples -> dicts,
numpy rate arrays -> list of dicts) so both ends stay dependency-light.
"""
from __future__ import annotations

PROTOCOL_VERSION = 1
MAX_ACCOUNTS = 3

# Message types
HELLO = "hello"
WELCOME = "welcome"
STATUS = "status"
CALL = "call"
RESULT = "result"
PING = "ping"
PONG = "pong"
ERROR = "error"

# Default MT5 constants, used by the Ubuntu side before/if the Companion
# has not advertised its own set. These are stable across MT5 builds.
MT5_CONSTANTS: dict[str, int] = {
    "ORDER_TYPE_BUY": 0,
    "ORDER_TYPE_SELL": 1,
    "ORDER_TYPE_BUY_LIMIT": 2,
    "ORDER_TYPE_SELL_LIMIT": 3,
    "ORDER_TYPE_BUY_STOP": 4,
    "ORDER_TYPE_SELL_STOP": 5,
    "POSITION_TYPE_BUY": 0,
    "POSITION_TYPE_SELL": 1,
    "TRADE_ACTION_DEAL": 1,
    "TRADE_ACTION_PENDING": 5,
    "TRADE_ACTION_SLTP": 6,
    "TRADE_ACTION_MODIFY": 7,
    "TRADE_ACTION_REMOVE": 8,
    "ORDER_TIME_GTC": 0,
    "ORDER_FILLING_FOK": 0,
    "ORDER_FILLING_IOC": 1,
    "ORDER_FILLING_RETURN": 2,
    "TRADE_RETCODE_DONE": 10009,
    "DEAL_TYPE_BUY": 0,
    "DEAL_TYPE_SELL": 1,
    "DEAL_ENTRY_IN": 0,
    "DEAL_ENTRY_OUT": 1,
    "TIMEFRAME_M1": 1,
    "TIMEFRAME_M5": 5,
    "TIMEFRAME_M15": 15,
    "TIMEFRAME_M30": 30,
    "TIMEFRAME_H1": 16385,
    "TIMEFRAME_H4": 16388,
    "TIMEFRAME_D1": 16408,
    "TIMEFRAME_W1": 32769,
}

# Functions the Companion is allowed to execute on behalf of the backend.
ALLOWED_FUNCTIONS = {
    "initialize",
    "shutdown",
    "last_error",
    "account_info",
    "symbol_info",
    "symbol_info_tick",
    "symbol_select",
    "positions_get",
    "orders_get",
    "history_deals_get",
    "copy_rates_from_pos",
    "order_send",
    "terminal_info",
}