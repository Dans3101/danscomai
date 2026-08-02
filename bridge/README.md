# MT5 Backend (Ubuntu) + Windows Companion

Phase 1 architecture: the trading logic stays on **Ubuntu**; MetaTrader 5 runs
**natively on Windows** inside the Companion Service. Wine, Xvfb, mt5linux and
RPyC are gone.

## Architecture

```
 Ubuntu VPS                                   Windows host
 ─────────────────────────────                ─────────────────────────────
  main.py (strategies, risk)                   companion.py
     │  remote_mt5 (sync RPC)                    ├ worker → MT5 (account 1)
     ▼  127.0.0.1:8766                           ├ worker → MT5 (account 2)
  companion_hub.py  ◀──── persistent wss ───▶    └ worker → MT5 (account 3)
     │
     ▼  https://YOUR-APP/api/public/bridge/{heartbeat,commands,strategies,ai-analysis}
```

The REST API, database, dashboard and strategy engine are unchanged — only the
MT5 transport was replaced.

| backend     | platform | use                                            |
| ----------- | -------- | ---------------------------------------------- |
| `remote`    | Linux    | default — talks to the Windows Companion        |
| `native`    | Windows  | official `MetaTrader5` package, same machine    |
| `simulator` | any      | dev/test, no broker connection                  |
| `auto`      | any      | native on Windows, remote on Linux              |

## Ubuntu install

```bash
git clone <this-repo> && cd <repo>
sudo bash install.sh          # one command: deps, venv, .env wizard,
                              # services, verification
journalctl -u mt5-companion-hub -f
```

`install.sh --upgrade` re-syncs code and dependencies without touching your
configuration; `--uninstall` removes the services. The older
`scripts/install-ubuntu.sh` remains for manual/step-by-step installs.

Installs Python, a venv, the hub + bridge systemd units (restart-on-failure)
and opens the companion WebSocket port. No Wine, no MT5 terminal on Linux.

### TLS

Recommended: terminate TLS with nginx/caddy and proxy
`wss://your-host/companion` → `http://127.0.0.1:8765`. Alternatively set
`HUB_TLS_CERT` / `HUB_TLS_KEY` in `.env` and the hub serves TLS itself.

### Hub status

```bash
curl -s http://127.0.0.1:8766/status | python3 -m json.tool
```

## Windows Companion

See [`../windows-companion/README.md`](../windows-companion/README.md).
Up to **3 MT5 accounts**, each needing only login / password / server, all
multiplexed over one outbound TLS WebSocket authenticated with the Bridge
Token.

## Simulator mode (no broker required)

```bash
MT5_BACKEND=simulator python main.py
```

The simulator produces synthetic ticks, snapshots, positions, and closed
trades so the dashboard shows a live-looking account without touching a real
broker. Ideal for CI and demos.

## Automatic recovery

- **Bridge crashes** → systemd/Docker restart (`Restart=always`).
- **Hub crashes** → systemd restarts it; the Companion reconnects on its own.
- **Companion or internet drop** → the Companion retries the WebSocket with
  exponential backoff (2s → 60s); RPCs fail fast with `503` meanwhile and the
  dashboard shows `connection_status=error`.
- **MT5 terminal closed or crashed** → the account worker relaunches
  `terminal64.exe` and logs back in on the next 10s healthcheck.
- **Worker process death** → the Companion supervisor restarts it.
- **Broker socket drop** → `mt5.initialize()` re-runs on the Windows side.
- **Dashboard unreachable** → heartbeats + command polls retry every
  `POLL_SECONDS`; nothing else blocks.
- **Health file** `HEALTH_FILE` is touched every loop iteration. External
  watchdogs (Docker HEALTHCHECK, cron, Uptime Kuma) can read it via
  `scripts/healthcheck.sh`.

## Security

- Run the services as an unprivileged user (`mt5bridge`), never root.
- `.env` is mode `600` and never committed.
- `BRIDGE_TOKEN` authenticates the Companion; rotate it from the dashboard.
- Broker credentials never leave the Windows host (`config.json`).
- Only whitelisted MT5 functions can be invoked remotely
  (`bridge/protocol.py::ALLOWED_FUNCTIONS`).
- The loopback RPC binds `127.0.0.1` only; the Windows host exposes no
  inbound ports.
- The systemd units enable `NoNewPrivileges` and `ProtectSystem=full`.

## Migrating from the Wine bridge

No dashboard, database, or API changes are required.

1. Stop and disable `mt5linux` and remove the Wine prefix.
2. Re-run `sudo bash scripts/install-ubuntu.sh` (Wine-free).
3. Set `MT5_BACKEND=remote` (or leave `auto`) and add `COMPANION_TOKENS`.
4. On Windows, set up `windows-companion/` and start it.
5. Confirm the dashboard shows the account as `Connected` and equity ticks.

## The companion EA

`mt5_autotrader.mq5` remains optional: it writes per-tick snapshots to MT5's
`Common\Files` folder on the Windows host for diagnostics. Copy it into the
terminal's `MQL5/Experts` folder, compile, and attach to any chart.