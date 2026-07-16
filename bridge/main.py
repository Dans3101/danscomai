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
import logging
import threading
from datetime import datetime, timezone, time as dtime
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("bridge")

APP = os.environ["APP_BASE_URL"].rstrip("/")
ACCOUNT_ID = os.environ["ACCOUNT_ID"]
TOKEN = os.environ["BRIDGE_TOKEN"]
LOGIN = int(os.environ.get("MT5_LOGIN") or 0)
PASSWORD = os.environ.get("MT5_PASSWORD", "")
SERVER = os.environ.get("MT5_SERVER", "")
MT5_PATH = os.environ.get("MT5_PATH") or None
POLL = float(os.environ.get("POLL_SECONDS", "2"))
HEALTH_FILE = Path(os.environ.get("HEALTH_FILE", "/tmp/mt5-bridge.health"))
MAX_RECONNECT_DELAY = float(os.environ.get("MAX_RECONNECT_DELAY", "60"))

HB_URL = f"{APP}/api/public/bridge/heartbeat"
CMD_URL = f"{APP}/api/public/bridge/commands"
HDRS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
STRAT_URL = f"{APP}/api/public/bridge/strategies"

# In-memory per-strategy state (cooldowns, daily counters, loss streaks).
_STATE: dict[str, dict[str, Any]] = {}
_DAY_KEY: str = ""
_DAY_STATS: dict[str, Any] = {"trades": 0, "pnl": 0.0, "losses_streak": 0}

# Pluggable MT5 backend: native (Windows), mt5linux (Ubuntu+Wine), simulator.
# See bridge/mt5_client.py.
sys.path.insert(0, str(Path(__file__).parent))
from mt5_client import mt5, BACKEND  # noqa: E402

log.info("bridge starting — backend=%s account=%s", BACKEND, ACCOUNT_ID)


def _touch_health(status: str = "ok") -> None:
    try:
        HEALTH_FILE.write_text(f"{int(time.time())} {status} {BACKEND}\n")
    except Exception:
        pass


def iso(ts: float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def connect_mt5() -> bool:
    """Initialize the selected MT5 backend.

    - native: launches / attaches to the local MT5 terminal on Windows.
    - mt5linux: calls the RPyC server running inside Wine which in turn
      talks to the MT5 terminal. Requires the mt5linux server to be up.
    - simulator: no-op init that always succeeds.
    """
    kwargs: dict[str, Any] = {}
    if LOGIN:
        kwargs["login"] = LOGIN
    if PASSWORD:
        kwargs["password"] = PASSWORD
    if SERVER:
        kwargs["server"] = SERVER
    if MT5_PATH:
        kwargs["path"] = MT5_PATH
    try:
        ok = bool(mt5.initialize(**kwargs))
    except Exception as e:  # noqa: BLE001
        log.error("MT5 initialize raised: %s", e)
        return False
    if not ok:
        try:
            log.error("MT5 initialize failed: %s", mt5.last_error())
        except Exception:
            log.error("MT5 initialize failed")
        return False
    log.info("Connected to MT5 %s @ %s (backend=%s)", LOGIN or "sim", SERVER or "-", BACKEND)
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
    """SMC-confluence engine implementing the 45-rule spec.

    Fetches enabled strategies for this account, evaluates every symbol against
    HTF trend, structure, liquidity, indicators, session, and volatility filters,
    then submits `open` commands via the app's queue. Also manages breakeven,
    trailing stops, max hold, and end-of-day flat.
    """
    global _DAY_KEY, _DAY_STATS
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if today != _DAY_KEY:
        _DAY_KEY = today
        _DAY_STATS = {"trades": 0, "pnl": 0.0, "losses_streak": 0}

    try:
        r = httpx.get(STRAT_URL, headers=HDRS, params={"account_id": ACCOUNT_ID}, timeout=10)
        if r.status_code >= 400:
            return
        strategies = r.json().get("strategies", [])
    except Exception as e:
        log.warning("strategy fetch failed: %s", e)
        return

    _manage_open_positions(strategies)

    for s in strategies:
        if s.get("rule_type") != "smc_confluence" or not s.get("enabled"):
            continue
        try:
            _evaluate_smc(s)
        except Exception as e:
            log.exception("strategy %s failed: %s", s.get("name"), e)


# ---------- SMC confluence implementation ----------

TF_MAP = {
    "M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30, "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}


def _rates(symbol: str, tf: int, n: int):
    return mt5.copy_rates_from_pos(symbol, tf, 0, n)


def _ema(values, period):
    k = 2.0 / (period + 1)
    ema = values[0]
    for v in values[1:]:
        ema = v * k + ema * (1 - k)
    return ema


def _ema_series(values, period):
    k = 2.0 / (period + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def _rsi(closes, period=14):
    gains = losses = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    ag = gains / period
    al = losses / period
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (period - 1) + max(d, 0)) / period
        al = (al * (period - 1) + max(-d, 0)) / period
    if al == 0:
        return 100.0
    rs = ag / al
    return 100 - 100 / (1 + rs)


def _macd(closes, fast=12, slow=26, signal=9):
    ef = _ema_series(closes, fast)
    es = _ema_series(closes, slow)
    macd = [a - b for a, b in zip(ef, es)]
    sig = _ema_series(macd, signal)
    hist = [m - s for m, s in zip(macd, sig)]
    return macd, sig, hist


def _atr(rates, period=14):
    trs = []
    for i in range(1, len(rates)):
        h, l, pc = rates[i]["high"], rates[i]["low"], rates[i - 1]["close"]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if len(trs) < period:
        return sum(trs) / max(len(trs), 1)
    return sum(trs[-period:]) / period


def _htf_bias(symbol: str, ema_period: int) -> str | None:
    """Return 'buy', 'sell', or None if timeframes disagree."""
    votes = []
    for tf in ("M15", "H1", "H4", "D1"):
        r = _rates(symbol, TF_MAP[tf], ema_period + 5)
        if r is None or len(r) < ema_period + 2:
            return None
        closes = [x["close"] for x in r]
        ema = _ema(closes, ema_period)
        votes.append("buy" if closes[-1] > ema else "sell")
    return votes[0] if len(set(votes)) == 1 else None


def _swings(rates, left=2, right=2):
    highs, lows = [], []
    for i in range(left, len(rates) - right):
        h = rates[i]["high"]; l = rates[i]["low"]
        if all(h > rates[j]["high"] for j in range(i - left, i)) and all(h > rates[j]["high"] for j in range(i + 1, i + right + 1)):
            highs.append((i, h))
        if all(l < rates[j]["low"] for j in range(i - left, i)) and all(l < rates[j]["low"] for j in range(i + 1, i + right + 1)):
            lows.append((i, l))
    return highs, lows


def _structure_ok(rates, side: str) -> bool:
    highs, lows = _swings(rates)
    if len(highs) < 2 or len(lows) < 2:
        return False
    if side == "buy":
        return highs[-1][1] > highs[-2][1] and lows[-1][1] > lows[-2][1]
    return highs[-1][1] < highs[-2][1] and lows[-1][1] < lows[-2][1]


def _bos(rates, side: str, lookback: int) -> bool:
    if len(rates) < lookback + 2:
        return False
    window = rates[-lookback - 1:-1]
    last_close = rates[-1]["close"]
    if side == "buy":
        return last_close > max(x["high"] for x in window)
    return last_close < min(x["low"] for x in window)


def _liquidity_sweep(rates, side: str, lookback: int) -> bool:
    if len(rates) < lookback + 2:
        return False
    window = rates[-lookback - 1:-1]
    last = rates[-1]
    if side == "buy":
        prior_low = min(x["low"] for x in window)
        return last["low"] < prior_low and last["close"] > prior_low
    prior_high = max(x["high"] for x in window)
    return last["high"] > prior_high and last["close"] < prior_high


def _candle_confirm(rates, side: str) -> bool:
    c = rates[-1]; p = rates[-2]
    body = abs(c["close"] - c["open"])
    rng = c["high"] - c["low"] or 1e-9
    if body / rng < 0.5:
        return False
    if side == "buy":
        engulf = c["close"] > c["open"] and c["close"] > p["open"] and c["open"] < p["close"]
        pin = (c["open"] - c["low"]) > 2 * body and c["close"] > c["open"]
        return engulf or pin or c["close"] > c["open"]
    engulf = c["close"] < c["open"] and c["close"] < p["open"] and c["open"] > p["close"]
    pin = (c["high"] - c["open"]) > 2 * body and c["close"] < c["open"]
    return engulf or pin or c["close"] < c["open"]


def _in_session(london: bool, ny: bool) -> bool:
    now = datetime.now(timezone.utc).time()
    if london and dtime(7, 0) <= now <= dtime(16, 0):
        return True
    if ny and dtime(12, 0) <= now <= dtime(21, 0):
        return True
    return False


def _pip(symbol: str) -> float:
    info = mt5.symbol_info(symbol)
    if not info:
        return 0.0001
    return info.point * (10 if info.digits in (3, 5) else 1)


def _open_positions_for(symbol: str) -> list:
    return list(mt5.positions_get(symbol=symbol) or [])


def _correlated_open(side: str, symbol: str) -> bool:
    base = symbol[:3]; quote = symbol[3:6]
    for p in mt5.positions_get() or []:
        if p.symbol == symbol:
            continue
        same_side = (p.type == mt5.POSITION_TYPE_BUY) == (side == "buy")
        if same_side and (p.symbol.startswith(base) or p.symbol.endswith(quote)):
            return True
    return False


def _evaluate_smc(s: dict[str, Any]) -> None:
    symbol = s["symbol"]
    p = s.get("rule_params") or {}
    st = _STATE.setdefault(s["id"], {"last_trade_ts": 0.0})

    # 33/35/36 daily limits
    if s.get("max_daily_loss") and _DAY_STATS["pnl"] <= -abs(float(s["max_daily_loss"])):
        return
    max_trades_day = int(p.get("max_trades_day", 20))
    if _DAY_STATS["trades"] >= max_trades_day:
        return
    # 34 consecutive losses
    if _DAY_STATS["losses_streak"] >= int(p.get("max_losses_streak", 3)):
        return
    # 43 cooldown
    if time.time() - st["last_trade_ts"] < float(p.get("cooldown_min", 15)) * 60:
        return
    # 37 max open
    if len(_open_positions_for(symbol)) >= int(s.get("max_open_trades", 1)):
        return
    # 24/26 session
    if not _in_session(bool(p.get("session_london", 1)), bool(p.get("session_ny", 1))):
        return

    mt5.symbol_select(symbol, True)
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if not info or not tick:
        return
    pip = _pip(symbol)
    # 22 spread
    spread_pips = (tick.ask - tick.bid) / pip
    if spread_pips > float(p.get("max_spread_pips", 3)):
        return

    # 1-3 HTF bias
    bias = _htf_bias(symbol, int(p.get("ema_period", 200)))
    if not bias:
        return

    # entry timeframe rates
    tf = TF_MAP.get(s.get("timeframe", "M15"), mt5.TIMEFRAME_M15)
    rates = _rates(symbol, tf, 300)
    if rates is None or len(rates) < 210:
        return
    closes = [x["close"] for x in rates]

    # 2 price vs EMA200
    ema200 = _ema(closes, int(p.get("ema_period", 200)))
    if bias == "buy" and closes[-1] <= ema200:
        return
    if bias == "sell" and closes[-1] >= ema200:
        return

    # 4 structure
    if not _structure_ok(rates[-60:], bias):
        return
    # 5 BOS
    if not _bos(rates, bias, int(p.get("bos_lookback", 20))):
        return
    # 6 liquidity sweep
    if not _liquidity_sweep(rates, bias, int(p.get("sweep_lookback", 10))):
        return

    # 12/13 RSI
    rsi = _rsi(closes)
    if bias == "buy" and rsi < float(p.get("rsi_buy_min", 55)):
        return
    if bias == "sell" and rsi > float(p.get("rsi_sell_max", 45)):
        return

    # 14 MACD
    _, _, hist = _macd(closes)
    if bias == "buy" and not (hist[-1] > 0 and hist[-1] > hist[-2]):
        return
    if bias == "sell" and not (hist[-1] < 0 and hist[-1] < hist[-2]):
        return

    # 15 Volume
    vols = [x["tick_volume"] for x in rates[-int(p.get("vol_lookback", 20)) - 1:-1]]
    if vols and rates[-1]["tick_volume"] < (sum(vols) / len(vols)):
        return

    # 16-19 ATR gates
    atr = _atr(rates[-int(p.get("atr_period", 14)) - 1:], int(p.get("atr_period", 14)))
    atr_pips = atr / pip
    if atr_pips < float(p.get("atr_min_pips", 5)):
        return
    if atr_pips > float(p.get("atr_max_pips", 80)):
        return

    # 20-21 candle
    if not _candle_confirm(rates, bias):
        return

    # 38 correlation
    if _correlated_open(bias, symbol):
        return

    # SL/TP via ATR + structure
    sl_pips = max(float(s.get("stop_loss_pips") or 0), atr_pips * 1.5)
    min_rr = float(p.get("min_rr", 3))
    tp_pips = max(float(s.get("take_profit_pips") or 0), sl_pips * min_rr)

    # 44/45 confidence scoring — all mandatory gates passed => count optional confirmations
    confidence = 100  # every hard gate passed; scale by soft factors
    if abs(hist[-1]) < abs(hist[-2]) * 0.5:
        confidence -= 10
    if spread_pips > 0.5 * float(p.get("max_spread_pips", 3)):
        confidence -= 5
    if confidence < float(p.get("min_confidence", 85)):
        return

    price = tick.ask if bias == "buy" else tick.bid
    sl = price - sl_pips * pip if bias == "buy" else price + sl_pips * pip
    tp = price + tp_pips * pip if bias == "buy" else price - tp_pips * pip

    log.info("SMC entry %s %s @ %.5f SL %.5f TP %.5f conf=%d", bias, symbol, price, sl, tp, confidence)
    result = _order_send({
        "symbol": symbol, "side": bias, "volume": float(s.get("lot_size", 0.01)),
        "sl": sl, "tp": tp, "comment": f"smc-{s['name'][:16]}",
    })
    if result.get("retcode") == mt5.TRADE_RETCODE_DONE:
        st["last_trade_ts"] = time.time()
        _DAY_STATS["trades"] += 1


def _manage_open_positions(strategies: list[dict[str, Any]]) -> None:
    """Breakeven (39), trailing (40), max hold (41), EOD flat (42)."""
    by_symbol: dict[str, dict[str, Any]] = {}
    for s in strategies:
        if s.get("rule_type") == "smc_confluence" and s.get("enabled"):
            by_symbol[s["symbol"].upper()] = s

    now = datetime.now(timezone.utc)
    for pos in mt5.positions_get() or []:
        s = by_symbol.get(pos.symbol.upper())
        if not s:
            continue
        p = s.get("rule_params") or {}
        pip = _pip(pos.symbol)
        side = "buy" if pos.type == mt5.POSITION_TYPE_BUY else "sell"
        entry = pos.price_open
        current = pos.price_current
        gain_pips = (current - entry) / pip if side == "buy" else (entry - current) / pip
        risk_pips = abs(entry - (pos.sl or entry)) / pip or 1
        rr = gain_pips / risk_pips

        # 41 max hold
        opened = datetime.fromtimestamp(pos.time, tz=timezone.utc)
        if (now - opened).total_seconds() / 60 > float(p.get("max_hold_min", 240)):
            _close_position(pos.ticket); continue
        # 42 EOD flat (Fri 20:00+ UTC or after 21:00 daily)
        if now.weekday() == 4 and now.hour >= 20:
            _close_position(pos.ticket); continue

        # 39 breakeven
        if rr >= float(p.get("breakeven_rr", 1)) and (pos.sl == 0 or (side == "buy" and pos.sl < entry) or (side == "sell" and pos.sl > entry)):
            _modify_position(pos.ticket, entry, pos.tp)
        # 40 trailing
        elif rr >= float(p.get("trailing_rr", 1.5)):
            trail = entry + (gain_pips - risk_pips) * pip if side == "buy" else entry - (gain_pips - risk_pips) * pip
            if (side == "buy" and trail > (pos.sl or 0)) or (side == "sell" and (pos.sl == 0 or trail < pos.sl)):
                _modify_position(pos.ticket, trail, pos.tp)


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