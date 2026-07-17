"""Prometheus metrics for the MT5 bridge.

Exposes an HTTP endpoint (default :9108/metrics) scraped by Prometheus.
All counters/gauges are safe to import even when prometheus_client is missing.
"""
from __future__ import annotations

import os
import logging

log = logging.getLogger("bridge.metrics")

try:
    from prometheus_client import Counter, Gauge, Histogram, start_http_server
    _ENABLED = True
except Exception:  # pragma: no cover
    _ENABLED = False

    class _Noop:
        def __getattr__(self, _): return self
        def __call__(self, *a, **k): return self
        def labels(self, *a, **k): return self
        def inc(self, *a, **k): pass
        def dec(self, *a, **k): pass
        def set(self, *a, **k): pass
        def observe(self, *a, **k): pass

    Counter = Gauge = Histogram = lambda *a, **k: _Noop()  # type: ignore
    def start_http_server(*a, **k): pass  # type: ignore


LABELS = ["account_id", "backend"]

bridge_up = Gauge("mt5_bridge_up", "1 if bridge loop healthy", LABELS)
mt5_connected = Gauge("mt5_connected", "1 if MT5 terminal is connected", LABELS)
reconnects_total = Counter("mt5_reconnects_total", "MT5 reconnect attempts", LABELS)
heartbeat_latency = Histogram(
    "mt5_heartbeat_latency_seconds",
    "Latency of heartbeat POST to the app",
    LABELS,
    buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10),
)
heartbeats_total = Counter("mt5_heartbeats_total", "Heartbeats sent", LABELS + ["status"])
commands_total = Counter("mt5_commands_total", "Bridge commands executed", LABELS + ["command", "status"])
trades_opened = Counter("mt5_trades_opened_total", "Trades opened by the engine", LABELS + ["symbol", "side"])
trades_closed = Counter("mt5_trades_closed_total", "Trades closed by the engine", LABELS + ["symbol", "reason"])
strategy_signals = Counter("mt5_strategy_signals_total", "Strategy signals emitted", LABELS + ["strategy", "action"])
open_positions = Gauge("mt5_open_positions", "Currently open positions", LABELS)
account_equity = Gauge("mt5_account_equity", "Account equity", LABELS)
account_balance = Gauge("mt5_account_balance", "Account balance", LABELS)
account_profit = Gauge("mt5_account_profit", "Floating profit", LABELS)


def start(account_id: str, backend: str) -> dict:
    port = int(os.environ.get("METRICS_PORT", "9108"))
    if _ENABLED and os.environ.get("METRICS_ENABLED", "1") not in ("0", "false", "no"):
        try:
            start_http_server(port)
            log.info("prometheus metrics on :%d/metrics", port)
        except OSError as e:
            log.warning("metrics port %d unavailable: %s", port, e)
    return {"account_id": account_id, "backend": backend}