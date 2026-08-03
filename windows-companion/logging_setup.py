"""Centralized logging for the Hub / Bridge / Companion services.

Provides:
  * console logging (journald / NSSM friendly)
  * size-based rotating file logs (LOG_DIR/<service>.log, 5 x 10 MB)
  * an in-process ring buffer of the last 24h of WARNING/ERROR records that the
    hub exposes over its loopback RPC and the bridge forwards to the dashboard
    log viewer.
"""
from __future__ import annotations

import logging
import os
import time
from collections import deque
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Deque

_RETENTION_SECONDS = 24 * 3600
_MAX_RECORDS = 2000
_BUFFER: Deque[dict[str, Any]] = deque(maxlen=_MAX_RECORDS)


class RecentErrorBuffer(logging.Handler):
    """Keeps the last 24h of warnings/errors in memory."""

    def emit(self, record: logging.LogRecord) -> None:
        if record.levelno < logging.WARNING:
            return
        _BUFFER.append(
            {
                "ts": record.created,
                "level": "error" if record.levelno >= logging.ERROR else "warn",
                "source": record.name,
                "message": self.format(record)[:4000],
            }
        )


def recent_errors(since_seconds: float = _RETENTION_SECONDS) -> list[dict[str, Any]]:
    """Return buffered warn/error entries newer than `since_seconds`."""
    cutoff = time.time() - since_seconds
    return [
        {**e, "ts_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(e["ts"]))}
        for e in list(_BUFFER)
        if e["ts"] >= cutoff
    ]


def setup(service: str) -> logging.Logger:
    """Configure root logging for a service and return its logger."""
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")

    root = logging.getLogger()
    root.setLevel(level)
    for h in list(root.handlers):
        root.removeHandler(h)

    console = logging.StreamHandler()
    console.setFormatter(fmt)
    root.addHandler(console)

    log_dir = Path(os.environ.get("LOG_DIR") or (Path(__file__).resolve().parent / "logs"))
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        max_bytes = int(os.environ.get("LOG_MAX_BYTES", str(10 * 1024 * 1024)))
        backups = int(os.environ.get("LOG_BACKUPS", "5"))
        rotating = RotatingFileHandler(
            log_dir / f"{service}.log", maxBytes=max_bytes, backupCount=backups, encoding="utf-8"
        )
        rotating.setFormatter(fmt)
        root.addHandler(rotating)
    except OSError as exc:
        root.warning("file logging disabled (%s)", exc)

    buf = RecentErrorBuffer()
    buf.setFormatter(logging.Formatter("%(message)s"))
    root.addHandler(buf)

    return logging.getLogger(service)
