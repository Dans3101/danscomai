"""MT5 client abstraction.

Selects one of three backends via `MT5_BACKEND`:

    remote     — Windows Companion Service reached through the local
                 Companion Hub (default on Linux; no Wine, no Xvfb)
    native     — official `MetaTrader5` package (running ON Windows)
    simulator  — in-process simulator, no broker connection required

All backends expose the same attribute surface used by `main.py`
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


def _load_remote():
    import remote_mt5  # type: ignore
    client = remote_mt5.build(os.environ.get("ACCOUNT_ID"))
    log.info("remote backend using companion hub at %s", remote_mt5.HUB_RPC)
    return client


def _resolve():
    global BACKEND
    order: list[str]
    if BACKEND == "auto":
        # On Windows use the native terminal; everywhere else talk to the
        # Windows Companion Service through the hub.
        import sys
        order = ["native"] if sys.platform == "win32" else ["remote"]
    else:
        order = [BACKEND]

    last_err: Exception | None = None
    for name in order:
        try:
            if name == "native":
                m = _load_native()
            elif name == "remote":
                m = _load_remote()
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