"""Simulator backend for local development and CI.

Implements just enough of the MetaTrader5 module surface to exercise the
full bridge loop (heartbeats, order queue, strategy engine) without a live
broker. Prices are a lazy random walk seeded per symbol.
"""
from __future__ import annotations

import math
import random
import time
import types
from dataclasses import dataclass, field
from typing import Any


# ---- constants (mirror MetaTrader5) ----
POSITION_TYPE_BUY = 0
POSITION_TYPE_SELL = 1
ORDER_TYPE_BUY = 0
ORDER_TYPE_SELL = 1
ORDER_TYPE_BUY_LIMIT = 2
ORDER_TYPE_SELL_LIMIT = 3
ORDER_TYPE_BUY_STOP = 4
ORDER_TYPE_SELL_STOP = 5
DEAL_ENTRY_IN = 0
DEAL_ENTRY_OUT = 1
DEAL_TYPE_BUY = 0
DEAL_TYPE_SELL = 1
TRADE_ACTION_DEAL = 1
TRADE_ACTION_SLTP = 6
ORDER_TIME_GTC = 0
ORDER_FILLING_IOC = 1
TRADE_RETCODE_DONE = 10009

TIMEFRAME_M1 = 1
TIMEFRAME_M5 = 5
TIMEFRAME_M15 = 15
TIMEFRAME_M30 = 30
TIMEFRAME_H1 = 60
TIMEFRAME_H4 = 240
TIMEFRAME_D1 = 1440


@dataclass
class _Position:
    ticket: int
    symbol: str
    type: int
    volume: float
    price_open: float
    price_current: float
    sl: float = 0.0
    tp: float = 0.0
    swap: float = 0.0
    profit: float = 0.0
    time: int = field(default_factory=lambda: int(time.time()))


@dataclass
class _Deal:
    ticket: int
    position_id: int
    symbol: str
    type: int
    entry: int
    volume: float
    price: float
    profit: float
    swap: float
    commission: float
    time: int


class _State:
    def __init__(self) -> None:
        self.balance = float(10_000)
        self.currency = "USD"
        self.positions: dict[int, _Position] = {}
        self.deals: list[_Deal] = []
        self._next_ticket = 100_000
        self._prices: dict[str, float] = {}

    def ticket(self) -> int:
        self._next_ticket += 1
        return self._next_ticket

    def price(self, symbol: str) -> float:
        if symbol not in self._prices:
            random.seed(hash(symbol) & 0xFFFFFFFF)
            self._prices[symbol] = 1.1000 if "JPY" not in symbol else 150.0
        # random walk
        self._prices[symbol] *= 1 + random.uniform(-0.0002, 0.0002)
        return self._prices[symbol]


def build() -> types.SimpleNamespace:
    s = _State()

    def initialize(**_: Any) -> bool:
        return True

    def shutdown() -> None:  # noqa: D401
        return None

    def last_error():
        return (0, "ok")

    def account_info():
        eq = s.balance + sum(p.profit for p in s.positions.values())
        return types.SimpleNamespace(
            balance=s.balance, equity=eq, margin=0.0, margin_free=eq,
            margin_level=100.0, profit=eq - s.balance, currency=s.currency,
        )

    def positions_get(**kw):
        vals = list(s.positions.values())
        if "ticket" in kw:
            vals = [p for p in vals if p.ticket == kw["ticket"]]
        if "symbol" in kw:
            vals = [p for p in vals if p.symbol == kw["symbol"]]
        return tuple(vals)

    def orders_get(**_: Any):
        return ()

    def history_deals_get(*_: Any, **__: Any):
        return tuple(s.deals[-200:])

    def symbol_select(_symbol: str, _enable: bool) -> bool:
        return True

    def symbol_info(symbol: str):
        return types.SimpleNamespace(point=0.00001, digits=5, name=symbol)

    def symbol_info_tick(symbol: str):
        p = s.price(symbol)
        return types.SimpleNamespace(bid=p - 0.00005, ask=p + 0.00005, time=int(time.time()))

    def copy_rates_from_pos(symbol: str, tf: int, start: int, count: int):
        base = s.price(symbol)
        rates = []
        for i in range(count):
            drift = math.sin((start + i) / 5) * 0.001
            o = base + drift
            h = o + random.uniform(0.0001, 0.0009)
            l = o - random.uniform(0.0001, 0.0009)
            c = o + random.uniform(-0.0005, 0.0005)
            rates.append({
                "time": int(time.time()) - (count - i) * tf * 60,
                "open": o, "high": h, "low": l, "close": c,
                "tick_volume": random.randint(100, 1000),
                "spread": 1, "real_volume": 0,
            })
        return rates

    def order_send(req: dict[str, Any]):
        action = req.get("action")
        if action == TRADE_ACTION_DEAL:
            pos_id = req.get("position")
            if pos_id and pos_id in s.positions:
                pos = s.positions.pop(pos_id)
                pnl = ((req["price"] - pos.price_open) if pos.type == POSITION_TYPE_BUY
                       else (pos.price_open - req["price"])) * pos.volume * 100_000
                s.balance += pnl
                s.deals.append(_Deal(
                    ticket=s.ticket(), position_id=pos.ticket, symbol=pos.symbol,
                    type=pos.type, entry=DEAL_ENTRY_OUT, volume=pos.volume,
                    price=req["price"], profit=pnl, swap=0.0, commission=0.0,
                    time=int(time.time()),
                ))
            else:
                t = s.ticket()
                s.positions[t] = _Position(
                    ticket=t, symbol=req["symbol"], type=req["type"],
                    volume=req["volume"], price_open=req["price"],
                    price_current=req["price"], sl=req.get("sl", 0.0),
                    tp=req.get("tp", 0.0),
                )
            return types.SimpleNamespace(retcode=TRADE_RETCODE_DONE, order=s.ticket(), deal=s.ticket(), comment="sim done")
        if action == TRADE_ACTION_SLTP:
            pos = s.positions.get(req["position"])
            if pos:
                pos.sl = req.get("sl", pos.sl)
                pos.tp = req.get("tp", pos.tp)
            return types.SimpleNamespace(retcode=TRADE_RETCODE_DONE, order=0, deal=0, comment="sim sltp")
        return types.SimpleNamespace(retcode=0, order=0, deal=0, comment="unknown")

    # Update price_current + floating pnl on each account_info tick.
    _orig_account = account_info

    def account_info_dyn():
        for pos in s.positions.values():
            pos.price_current = s.price(pos.symbol)
            pnl_pips = (pos.price_current - pos.price_open) if pos.type == POSITION_TYPE_BUY \
                else (pos.price_open - pos.price_current)
            pos.profit = pnl_pips * pos.volume * 100_000
        return _orig_account()

    ns = types.SimpleNamespace(
        # constants
        POSITION_TYPE_BUY=POSITION_TYPE_BUY, POSITION_TYPE_SELL=POSITION_TYPE_SELL,
        ORDER_TYPE_BUY=ORDER_TYPE_BUY, ORDER_TYPE_SELL=ORDER_TYPE_SELL,
        ORDER_TYPE_BUY_LIMIT=ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_SELL_LIMIT=ORDER_TYPE_SELL_LIMIT,
        ORDER_TYPE_BUY_STOP=ORDER_TYPE_BUY_STOP, ORDER_TYPE_SELL_STOP=ORDER_TYPE_SELL_STOP,
        DEAL_ENTRY_IN=DEAL_ENTRY_IN, DEAL_ENTRY_OUT=DEAL_ENTRY_OUT,
        DEAL_TYPE_BUY=DEAL_TYPE_BUY, DEAL_TYPE_SELL=DEAL_TYPE_SELL,
        TRADE_ACTION_DEAL=TRADE_ACTION_DEAL, TRADE_ACTION_SLTP=TRADE_ACTION_SLTP,
        ORDER_TIME_GTC=ORDER_TIME_GTC, ORDER_FILLING_IOC=ORDER_FILLING_IOC,
        TRADE_RETCODE_DONE=TRADE_RETCODE_DONE,
        TIMEFRAME_M1=TIMEFRAME_M1, TIMEFRAME_M5=TIMEFRAME_M5, TIMEFRAME_M15=TIMEFRAME_M15,
        TIMEFRAME_M30=TIMEFRAME_M30, TIMEFRAME_H1=TIMEFRAME_H1, TIMEFRAME_H4=TIMEFRAME_H4,
        TIMEFRAME_D1=TIMEFRAME_D1,
        # functions
        initialize=initialize, shutdown=shutdown, last_error=last_error,
        account_info=account_info_dyn,
        positions_get=positions_get, orders_get=orders_get,
        history_deals_get=history_deals_get,
        symbol_select=symbol_select, symbol_info=symbol_info,
        symbol_info_tick=symbol_info_tick, copy_rates_from_pos=copy_rates_from_pos,
        order_send=order_send,
    )
    return ns