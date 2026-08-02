"""Windows DPAPI-protected configuration storage.

`install.ps1` writes `config.secure.json` — the companion configuration
encrypted with Windows DPAPI at LocalMachine scope, so only code running on
this machine (including the LocalSystem service account) can read it. The
plaintext MT5 password never touches disk.

Falls back to plain `config.json` for development.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from typing import Any

SECURE_NAME = "config.secure.json"
PLAIN_NAME = "config.json"


class _Blob:
    pass


def _dpapi_unprotect(data: bytes) -> bytes:
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    ):
        raise RuntimeError(
            "DPAPI decryption failed — config.secure.json was created on a "
            "different machine or account. Re-run install.ps1 as Administrator."
        )
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def load(directory: Path) -> dict[str, Any]:
    secure = directory / SECURE_NAME
    plain = directory / PLAIN_NAME
    if secure.exists():
        if sys.platform != "win32":
            raise SystemExit(f"{SECURE_NAME} can only be decrypted on Windows")
        raw = _dpapi_unprotect(base64.b64decode(secure.read_text(encoding="utf-8").strip()))
        return json.loads(raw.decode("utf-8"))
    if plain.exists():
        return json.loads(plain.read_text(encoding="utf-8"))
    raise SystemExit(
        f"no configuration found in {directory}. Run install.ps1 (recommended) "
        f"or copy config.example.json to config.json."
    )