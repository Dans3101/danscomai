"""Remote MT5 client for Ubuntu.

Drop-in replacement for the `MetaTrader5` python module. Every call is
forwarded, synchronously, to the local Companion Hub over loopback HTTP; the
hub relays it to the Windows Companion over the persistent WebSocket and
returns the JSON-normalised result.

This module replaces the previous Wine / mt5linux backend — no Wine, no
Xvfb, no RPyC, no MT5 terminal on Linux.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

import protocol as P

log = logging.getLogger("bridge.remote_mt5")

HUB_RPC = os.environ.get(
    "HUB_RPC_URL",
    f"http://{os.environ.get('HUB_RPC_HOST', '127.0.0.1')}:{os.environ.get('HUB_RPC_PORT', '8766')}",
).rstrip("/")
RPC_TIMEOUT = float(os.environ.get("RPC_TIMEOUT", "30"))


class Obj:
    """Attribute + item access wrapper for a JSON dict (mimics MT5 namedtuples)."""

    __slots__ = ("_d",)

    def __init__(self, d: dict[str, Any]):
        object.__setattr__(self, "_d", d)

    def __getattr__(self, name: str) -> Any:
        try:
            return object.__getattribute__(self, "_d")[name]
        except KeyError as e:
            raise AttributeError(name) from e

    def __getitem__(self, key: str) -> Any:
        return object.__getattribute__(self, "_d")[key]

    def get(self, key: str, default: Any = None) -> Any:
        return object.__getattribute__(self, "_d").get(key, default)

    def _asdict(self) -> dict[str, Any]:
        return dict(object.__getattribute__(self, "_d"))

    def __repr__(self) -> str:
        return f"Obj({object.__getattribute__(self, '_d')!r})"


def _wrap(value: Any, fn: str) -> Any:
    # Rates stay plain dicts — the strategy engine indexes them by key.
    if fn == "copy_rates_from_pos":
        return value
    if isinstance(value, dict):
        return Obj(value)
    if isinstance(value, list):
        return tuple(_wrap(v, fn) for v in value)
    return value


class RemoteMT5:
    """Exposes the MT5 surface used by the bridge, backed by the Companion."""

    def __init__(self, account_id: str, base_url: str = HUB_RPC):
        self.account_id = account_id
        self.base_url = base_url
        self._client = httpx.Client(timeout=RPC_TIMEOUT + 5)
        self._last_error: Any = (0, "ok")
        self._constants: dict[str, int] = dict(P.MT5_CONSTANTS)
        self._load_constants()

    # -- constants -------------------------------------------------------
    def _load_constants(self) -> None:
        try:
            r = self._client.post(f"{self.base_url}/constants",
                                  json={"account_id": self.account_id})
            data = r.json()
            if data.get("ok") and data.get("constants"):
                self._constants.update({k: int(v) for k, v in data["constants"].items()
                                        if isinstance(v, (int, float))})
        except Exception as e:  # noqa: BLE001
            log.debug("constants fetch failed, using defaults: %s", e)

    def __getattr__(self, name: str) -> Any:
        consts = object.__getattribute__(self, "_constants")
        if name in consts:
            return consts[name]
        if name in P.ALLOWED_FUNCTIONS:
            def _call(*args: Any, **kwargs: Any) -> Any:
                return object.__getattribute__(self, "_rpc")(name, list(args), kwargs)
            return _call
        raise AttributeError(name)

    # -- transport -------------------------------------------------------
    def _rpc(self, fn: str, args: list, kwargs: dict) -> Any:
        try:
            r = self._client.post(
                f"{self.base_url}/rpc",
                json={"account_id": self.account_id, "fn": fn, "args": args, "kwargs": kwargs},
            )
            data = r.json()
        except Exception as e:  # noqa: BLE001
            self._last_error = (-1, f"hub unreachable: {e}")
            log.warning("rpc %s failed: %s", fn, e)
            return None
        if not data.get("ok"):
            self._last_error = (-2, str(data.get("error")))
            if fn not in ("initialize", "last_error"):
                log.warning("rpc %s error: %s", fn, data.get("error"))
            return False if fn in ("initialize", "symbol_select") else None
        self._last_error = (0, "ok")
        return _wrap(data.get("result"), fn)

    # -- explicit surface -------------------------------------------------
    def initialize(self, **kwargs: Any) -> bool:
        """Ask the Companion to (re)attach the terminal for this account."""
        return bool(self._rpc("initialize", [], kwargs))

    def shutdown(self) -> None:
        self._rpc("shutdown", [], {})

    def last_error(self) -> Any:
        remote = self._rpc("last_error", [], {})
        return remote if remote else self._last_error


def build(account_id: str | None = None) -> RemoteMT5:
    return RemoteMT5(account_id or os.environ["ACCOUNT_ID"])


__all__ = ["RemoteMT5", "build", "Obj"]