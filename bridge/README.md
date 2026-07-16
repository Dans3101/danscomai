# MT5 Bridge

Broker-agnostic Python service that connects an MT5 terminal to the Lovable
dashboard. Runs on **Ubuntu 22.04+ with Wine** (recommended), on Windows, or
in **simulator** mode for local development.

## Architecture

```
 MT5 terminal (Wine)  <->  mt5linux RPyC server  <->  Python bridge
       ^                                                    |
       |                                                    v
  any broker (XM, Exness, IC Markets,           https://YOUR-APP
  FBS, Pepperstone, HFM, Tickmill,               /api/public/bridge/
  Deriv MT5, FXPesa, ...)                        heartbeat | commands
                                                          | strategies
```

The bridge selects a backend at startup (`MT5_BACKEND`):

| backend    | platform         | use                                   |
| ---------- | ---------------- | ------------------------------------- |
| `native`   | Windows          | official `MetaTrader5` package        |
| `mt5linux` | Ubuntu + Wine    | default on Linux, RPyC to Wine        |
| `simulator`| any              | dev/test, no broker connection        |
| `auto`     | any              | native on Win, mt5linux on Linux      |

Broker-agnostic — only `BROKER`, `MT5_LOGIN`, `MT5_PASSWORD`, `MT5_SERVER`
are required. No broker-specific code.

## One-command Ubuntu install

Works on any Ubuntu 22.04 / 24.04 VPS: Oracle Cloud Always Free, GCP Compute
Engine, AWS EC2, Azure, Contabo, Hetzner, DigitalOcean, Vultr, Linode.

```bash
git clone <this-repo> && cd bridge
sudo bash scripts/install-ubuntu.sh
# edit .env with values from the dashboard Accounts panel
sudo systemctl start mt5linux mt5-bridge
journalctl -u mt5-bridge -f
```

The installer sets up: Wine (stable), Python 3.11 under Wine, MetaTrader 5
terminal (silent install), `mt5linux` + `rpyc`, a dedicated `mt5bridge`
system user, a Python venv, and two systemd services with automatic
restart-on-failure.

## Docker

```bash
cp .env.example .env   # fill in
docker compose up -d
docker compose logs -f
```

The Compose file persists the Wine prefix (`wine-prefix` volume) so the MT5
terminal login survives container rebuilds. Docker `HEALTHCHECK` reads
`/tmp/mt5-bridge.health`.

## Windows (unchanged from earlier releases)

```powershell
pip install -r requirements.txt
copy .env.example .env
python main.py
```

`MT5_BACKEND=auto` picks `native` automatically.

## Simulator mode (no broker required)

```bash
MT5_BACKEND=simulator python main.py
```

The simulator produces synthetic ticks, snapshots, positions, and closed
trades so the dashboard shows a live-looking account without touching a real
broker. Ideal for CI and demos.

## Automatic recovery

- **Bridge crashes** → systemd/Docker restart (`Restart=always`).
- **mt5linux RPyC crashes** → systemd restarts it (`Restart=always`).
- **MT5 terminal crash under Wine** → the mt5linux service respawns Wine,
  the bridge reconnects via exponential backoff (up to `MAX_RECONNECT_DELAY`).
- **Broker socket drop** → `mt5.initialize()` re-runs inside `_reconnect_loop`;
  the dashboard sees `connection_status=error` during the gap.
- **Dashboard unreachable** → heartbeats + command polls retry every
  `POLL_SECONDS`; nothing else blocks.
- **Health file** `HEALTH_FILE` is touched every loop iteration. External
  watchdogs (Docker HEALTHCHECK, cron, Uptime Kuma) can read it via
  `scripts/healthcheck.sh`.

## Security

- Run the service as an unprivileged user (`mt5bridge`), never root.
- `.env` is mode `600` and never committed.
- `BRIDGE_TOKEN` is a per-account opaque secret; rotate it from the dashboard.
- MT5 credentials are AES-GCM encrypted at rest in the platform database.
- The systemd units enable `NoNewPrivileges`, `ProtectSystem=full`, and
  `PrivateTmp`.
- The bridge only calls two HTTPS endpoints on your app; no inbound ports
  are exposed (RPyC binds to `127.0.0.1` only).

## Migrating from the old Windows-only bridge

No dashboard, database, or API changes are required — only the bridge
process moves.

1. Stop the Windows bridge (or leave it running for cutover safety).
2. Provision an Ubuntu VPS.
3. Run `sudo bash scripts/install-ubuntu.sh`.
4. Copy your existing `.env` from Windows to `/home/mt5bridge/mt5-bridge/.env`,
   or paste values fresh from the dashboard.
5. Add one new line: `MT5_BACKEND=mt5linux` (or leave `auto`).
6. Start the services.
7. Confirm the dashboard shows the account as `Connected` and equity ticks.
8. Decommission the Windows VPS.

All existing strategies, positions, trade history, and logs continue to
work unchanged — the bridge speaks the same heartbeat/commands/strategies
API.

## The companion EA

`mt5_autotrader.mq5` is optional. It writes a per-tick snapshot to MT5's
`Common\Files` folder, which the bridge can tail as a fallback when the
RPyC channel is temporarily unavailable. Copy it into the MT5 terminal's
`MQL5/Experts` folder, compile, and attach to any chart.