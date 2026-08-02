"""Pre-flight check: can this machine reach the Ubuntu backend and is the
Bridge Token accepted? Exits 0 on success, non-zero with a clear message.

Usage: python verify_connection.py <ws_url> <token> [account_id ...]
"""
from __future__ import annotations

import asyncio
import json
import ssl
import sys

import websockets

import protocol as P


async def main() -> int:
    if len(sys.argv) < 3:
        print("usage: verify_connection.py <ws_url> <token> [account_id ...]")
        return 2
    url, token = sys.argv[1].rstrip("/"), sys.argv[2]
    accounts = [{"account_id": a, "login": 0, "server": ""} for a in sys.argv[3:]]
    ctx = ssl.create_default_context() if url.startswith("wss://") else None
    try:
        async with websockets.connect(url, ssl=ctx, open_timeout=15, close_timeout=5) as ws:
            await ws.send(json.dumps({
                "type": P.HELLO, "version": P.PROTOCOL_VERSION, "token": token,
                "companion": "installer-preflight", "constants": {}, "accounts": accounts,
            }))
            raw = await asyncio.wait_for(ws.recv(), 15)
            msg = json.loads(raw)
            if msg.get("type") == P.WELCOME:
                print("OK: backend accepted the Bridge Token")
                return 0
            print(f"FAIL: backend refused the connection ({msg.get('message') or msg}). "
                  "Check the Bridge Token matches the one in the Ubuntu .env.")
            return 1
    except asyncio.TimeoutError:
        print("FAIL: backend did not answer the handshake in time.")
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"FAIL: cannot reach {url} ({e}). "
              "Check the URL, the cloud firewall (TCP port) and that "
              "mt5-companion-hub is running on Ubuntu.")
        return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))