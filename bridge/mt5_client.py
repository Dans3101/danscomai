"""MT5 client abstraction.

Selects one of three backends via `MT5_BACKEND`:

    native     — official `MetaTrader5` package (Windows only)
    mt5linux   — `mt5linux` RPyC bridge to an MT5 terminal running under Wine
    simulator  — in-process simulator, no broker connection required

All three backends expose the same attribute surface used by `main.py`
(constants + functions), so the rest of the bridge is broker- and
platform-agnostic.
"""
from __future__ import annotations

import os
import logging

log = logging.getLogger("bridge.mt5")

BACKEND = (os.environ.get("MT5_BACKEND") or "auto").lower()


def _load_native():
    import MetaTrader5 as mt5  # type: ignore
    return mt5


def _load_mt5linux():
    # mt5linux ships a drop-in `MetaTrader5` class that speaks RPyC to a
    # tiny Python server running INSIDE Wine next to the MT5 terminal.
    from mt5linux import MetaTrader5  # type: ignore
    host = os.environ.get("MT5LINUX_HOST", "127.0.0.1")
    port = int(os.environ.get("MT5LINUX_PORT", "18812"))
    client = MetaTrader5(host=host, port=port)
    log.info("mt5linux backend connected to %s:%s", host, port)
    return client


def _load_simulator():
    from . import simulator  # type: ignore
    return simulator.build()


def _resolve():
    global BACKEND
    order: list[str]
    if BACKEND == "auto":
        # Prefer real broker connection; fall back to simulator only if
        # explicitly requested via BACKEND=simulator.
        import sys
        order = ["native"] if sys.platform == "win32" else ["mt5linux"]
    else:
        order = [BACKEND]

    last_err: Exception | None = None
    for name in order:
        try:
            if name == "native":
                m = _load_native()
            elif name == "mt5linux":
                m = _load_mt5linux()
            elif name == "simulator":
                # Local import (not relative) so `python bridge/main.py` works.
                import simulator  # type: ignore
                m = simulator.build()
            else:
                raise RuntimeError(f"unknown MT5_BACKEND {name}")
            BACKEND = name
            log.info("MT5 backend: %s", name)
            return m
        except Exception as e:  # noqa: BLE001
            last_err = e
            log.warning("backend %s unavailable: %s", name, e)
    raise RuntimeError(f"no MT5 backend available (last error: {last_err})")


mt5 = _resolve()

__all__ = ["mt5", "BACKEND"]