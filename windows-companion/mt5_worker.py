"""Per-account MT5 worker (Windows).

Each MT5 account runs in its own worker PROCESS with its own MT5 terminal
installation/data directory, because the official `MetaTrader5` package binds
one terminal per process. The worker:

  * launches the terminal if it is closed (`mt5.initialize(path=...)`)
  * logs in with login / password / server
  * executes RPC calls received from the Ubuntu backend
  * reconnects automatically after terminal or broker interruptions
  * normalises every MT5 return value to plain JSON
"""
from __future__ import annotations

import logging
import time
from multiprocessing import Process, Queue
from typing import Any

import protocol as P

log = logging.getLogger("companion.worker")


# --------------------------------------------------------------------------
# JSON normalisation
# --------------------------------------------------------------------------
def to_json(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if hasattr(value, "_asdict"):
        return {k: to_json(v) for k, v in value._asdict().items()}
    if isinstance(value, dict):
        return {str(k): to_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_json(v) for v in value]
    # numpy structured array (copy_rates_from_pos)
    dtype = getattr(value, "dtype", None)
    if dtype is not None and getattr(dtype, "names", None):
        return [{name: _py(row[name]) for name in dtype.names} for row in value]
    if hasattr(value, "tolist"):
        return to_json(value.tolist())
    return str(value)


def _py(v: Any) -> Any:
    return v.item() if hasattr(v, "item") else v


# --------------------------------------------------------------------------
# Worker process body
# --------------------------------------------------------------------------
def _worker_main(cfg: dict[str, Any], req_q: Queue, res_q: Queue) -> None:
    logging.basicConfig(
        level=cfg.get("log_level", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    wlog = logging.getLogger(f"worker[{cfg['account_id'][:8]}]")
    import MetaTrader5 as mt5  # type: ignore

    state = {"connected": False, "last_connect": 0.0, "error": None}

    def constants() -> dict[str, int]:
        out: dict[str, int] = {}
        for name in P.CONSTANT_NAMES:
            v = getattr(mt5, name, None)
            if isinstance(v, int):
                out[name] = int(v)
        return out

    def connect(force: bool = False) -> bool:
        """Launch the terminal if needed and log the account in."""
        if state["connected"] and not force:
            return True
        kwargs: dict[str, Any] = {
            "login": int(cfg["login"]),
            "password": cfg["password"],
            "server": cfg["server"],
        }
        if cfg.get("terminal_path"):
            kwargs["path"] = cfg["terminal_path"]  # starts terminal64.exe if closed
        if cfg.get("portable"):
            kwargs["portable"] = True
        try:
            mt5.shutdown()
        except Exception:
            pass
        try:
            ok = bool(mt5.initialize(**kwargs))
        except Exception as e:  # noqa: BLE001
            state.update(connected=False, error=str(e))
            wlog.error("initialize raised: %s", e)
            return False
        if not ok:
            state.update(connected=False, error=str(mt5.last_error()))
            wlog.error("initialize failed: %s", state["error"])
            return False
        state.update(connected=True, error=None, last_connect=time.time())
        wlog.info("MT5 connected login=%s server=%s", cfg["login"], cfg["server"])
        return True

    def alive() -> bool:
        try:
            return mt5.account_info() is not None
        except Exception:
            return False

    connect()
    res_q.put({"kind": "constants", "account_id": cfg["account_id"], "data": constants()})

    while True:
        try:
            req = req_q.get()
        except (EOFError, KeyboardInterrupt):
            break
        if req is None:
            break

        kind = req.get("kind", "call")
        if kind == "healthcheck":
            healthy = state["connected"] and alive()
            if not healthy:
                healthy = connect(force=True)
            res_q.put({
                "kind": "status", "account_id": cfg["account_id"],
                "connected": bool(healthy), "error": state["error"],
                "terminal": "running" if healthy else "down",
            })
            continue

        rid = req.get("id")
        fn = req.get("fn")
        args = list(req.get("args") or [])
        kwargs = dict(req.get("kwargs") or {})

        if fn not in P.ALLOWED_FUNCTIONS:
            res_q.put({"kind": "result", "id": rid, "ok": False, "error": f"forbidden fn {fn}"})
            continue

        # The backend's initialize() means "make sure this account is live".
        if fn == "initialize":
            ok = connect(force=True)
            res_q.put({"kind": "result", "id": rid, "ok": True, "result": ok})
            continue
        if fn == "shutdown":
            res_q.put({"kind": "result", "id": rid, "ok": True, "result": None})
            continue

        if not state["connected"] and not connect(force=True):
            res_q.put({"kind": "result", "id": rid, "ok": False,
                       "error": f"mt5 not connected: {state['error']}"})
            continue

        try:
            out = getattr(mt5, fn)(*args, **kwargs)
            if out is None and fn in ("account_info", "symbol_info_tick") and not alive():
                # Terminal dropped mid-call: reconnect once and retry.
                if connect(force=True):
                    out = getattr(mt5, fn)(*args, **kwargs)
            res_q.put({"kind": "result", "id": rid, "ok": True, "result": to_json(out)})
        except Exception as e:  # noqa: BLE001
            state.update(connected=False, error=str(e))
            res_q.put({"kind": "result", "id": rid, "ok": False, "error": str(e)})

    try:
        mt5.shutdown()
    except Exception:
        pass


class AccountWorker:
    """Supervisor handle for one account's worker process."""

    def __init__(self, cfg: dict[str, Any]):
        self.cfg = cfg
        self.account_id = str(cfg["account_id"])
        self.req_q: Queue = Queue()
        self.res_q: Queue = Queue()
        self.proc: Process | None = None
        self.constants: dict[str, int] = {}
        self.status: dict[str, Any] = {"connected": False, "terminal": "unknown", "error": None}

    def start(self) -> None:
        self.proc = Process(target=_worker_main, args=(self.cfg, self.req_q, self.res_q),
                            daemon=True, name=f"mt5-{self.account_id[:8]}")
        self.proc.start()
        log.info("worker started for account %s (login %s)", self.account_id, self.cfg["login"])

    def ensure_alive(self) -> None:
        if self.proc is None or not self.proc.is_alive():
            log.warning("worker for %s died — restarting", self.account_id)
            self.start()

    def submit(self, msg: dict[str, Any]) -> None:
        self.req_q.put(msg)

    def drain(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        while not self.res_q.empty():
            try:
                out.append(self.res_q.get_nowait())
            except Exception:
                break
        return out

    def stop(self) -> None:
        try:
            self.req_q.put(None)
        except Exception:
            pass
        if self.proc and self.proc.is_alive():
            self.proc.join(timeout=10)
            if self.proc.is_alive():
                self.proc.terminate()