"""Wire protocol (mirror of bridge/protocol.py).

Kept as a standalone copy so the Windows Companion folder can be shipped to
the Windows host on its own, with no dependency on the Ubuntu backend tree.
"""
from __future__ import annotations

PROTOCOL_VERSION = 1
MAX_ACCOUNTS = 3

HELLO = "hello"
WELCOME = "welcome"
STATUS = "status"
CALL = "call"
RESULT = "result"
PING = "ping"
PONG = "pong"
ERROR = "error"

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

CONSTANT_NAMES = [
    "ORDER_TYPE_BUY", "ORDER_TYPE_SELL", "ORDER_TYPE_BUY_LIMIT",
    "ORDER_TYPE_SELL_LIMIT", "ORDER_TYPE_BUY_STOP", "ORDER_TYPE_SELL_STOP",
    "POSITION_TYPE_BUY", "POSITION_TYPE_SELL",
    "TRADE_ACTION_DEAL", "TRADE_ACTION_PENDING", "TRADE_ACTION_SLTP",
    "TRADE_ACTION_MODIFY", "TRADE_ACTION_REMOVE",
    "ORDER_TIME_GTC", "ORDER_FILLING_FOK", "ORDER_FILLING_IOC",
    "ORDER_FILLING_RETURN", "TRADE_RETCODE_DONE",
    "DEAL_TYPE_BUY", "DEAL_TYPE_SELL", "DEAL_ENTRY_IN", "DEAL_ENTRY_OUT",
    "TIMEFRAME_M1", "TIMEFRAME_M5", "TIMEFRAME_M15", "TIMEFRAME_M30",
    "TIMEFRAME_H1", "TIMEFRAME_H4", "TIMEFRAME_D1", "TIMEFRAME_W1",
]