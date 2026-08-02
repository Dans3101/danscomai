# DANSCOMFX — AI-powered MT5 Trading Bot

Dashboard (Lovable Cloud) + Ubuntu bridge + Windows Companion running
MetaTrader 5 natively. Strategy: 45-rule SMC confluence engine on **XAUUSD**,
with an AI sentiment audit before every execution.

```
 Browser ── Dashboard (auth, settings, live account, logs)
                │  https  /api/public/bridge/*
 Ubuntu VPS ── main.py (strategy + risk)  ──127.0.0.1:8766──  companion_hub.py
                                                     ▲ persistent WSS (outbound)
 Windows PC/VPS ─────────────────────────── companion.py ── MetaTrader 5 (1–3 accounts)
```

No Wine, no Xvfb, no inbound ports on Windows. Broker credentials never leave
the Windows machine.

---

## 1. What you need

| Item | Why |
| --- | --- |
| Published dashboard URL | the bridge posts heartbeats/trades to it |
| Ubuntu 22.04/24.04 VPS (1 vCPU / 1 GB is enough) | runs the strategy + hub 24/7 |
| Windows machine or VPS with MetaTrader 5 + Python 3.10+ | runs MT5 natively |
| MT5 login / password / server | from your broker |
| Account ID + Bridge Token | Dashboard → **Accounts** → Bridge config |
| Open TCP port (default 8765, or 443 behind nginx) | Companion → hub link |

Both machines must stay powered on for the bot to trade unattended.

## 2. Install the Ubuntu backend (one command)

```bash
git clone <this-repo> && cd <repo>
sudo bash install.sh
```

The installer: creates the `mt5bridge` user, installs system packages, builds
the virtualenv, installs Python deps, walks you through `.env`
(dashboard URL, Account ID, Bridge Token), **verifies the dashboard accepts
your token**, installs + enables + starts `mt5-companion-hub` and
`mt5-bridge`, opens the firewall port, and health-checks everything. It prints
the exact `ws://…` URL to use on Windows.

```bash
sudo bash install.sh --upgrade      # new code + deps, keep config
sudo bash install.sh --uninstall    # remove services
sudo bash install.sh --non-interactive   # values from env vars
```

### TLS (recommended)
Put nginx/caddy in front and proxy `wss://your-domain/companion` →
`http://127.0.0.1:8765`, or set `HUB_TLS_CERT` / `HUB_TLS_KEY` in `.env`.

## 3. Install the Windows Companion (service)

Copy the `windows-companion` folder to the Windows machine, then in an
**elevated** PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

The wizard asks only for: **Backend URL, Bridge Token, Account ID, MT5 Login,
MT5 Password, MT5 Server**. It then:

- checks Python and locates `terminal64.exe`,
- creates the venv and installs `MetaTrader5` + `websockets`,
- **verifies the backend link and the Bridge Token before installing anything**,
- encrypts the credentials with Windows **DPAPI** (`config.secure.json`,
  machine-bound, readable only by SYSTEM/Administrators — no plaintext password
  on disk),
- registers the `MT5Companion` Windows Service: **auto-start at boot**,
  restart on failure (5s → 10s → 30s), rotating logs in `logs\`,
- starts it and confirms it reached *Running* and linked to the backend.

```powershell
.\install.ps1 -Upgrade      # update deps + restart, keep credentials
.\install.ps1 -Uninstall    # remove the service
Get-Content .\logs\companion.log -Tail 50 -Wait
```

## 4. Verify end to end

```bash
# Ubuntu
systemctl status mt5-companion-hub mt5-bridge
curl -s http://127.0.0.1:8766/status | jq      # companion + per-account status
journalctl -u mt5-bridge -f                     # strategy evaluation loop
```

Then open the dashboard: the account should show **Connected** with live
balance, equity, free margin, margin level, positions and logs.

## 5. Automatic recovery (nothing to do manually)

| Failure | Recovery |
| --- | --- |
| Windows reboots | service auto-starts (delayed-auto) and reconnects |
| Internet drops | Companion retries with backoff 2s → 60s |
| MT5 closed/crashed | worker relaunches `terminal64.exe`, re-logs in (10s healthcheck) |
| Worker process dies | supervisor restarts it |
| Hub or bridge crashes | systemd `Restart=always` |
| Dashboard unreachable | heartbeats/commands retry every `POLL_SECONDS` |
| Companion offline | RPCs fail fast (503) and the dashboard shows `error` |

## 6. Before letting it trade live

1. Enable **Algo Trading** in MetaTrader 5 and allow the symbol `XAUUSD`
   (your broker's suffix, e.g. `XAUUSD.m`, is auto-detected).
2. On the dashboard set: lot size / risk %, stop loss, take profit, trailing
   stop, max daily loss, max open trades, sessions (London/NY), and enable the
   strategy.
3. Run on a **demo account first** for at least a few sessions.
4. Optional: `MT5_BACKEND=simulator` on Ubuntu to dry-run without a broker.

## 7. Monitoring (optional)

```bash
cd bridge/monitoring && docker compose -f docker-compose.monitoring.yml up -d
```
Prometheus scrapes the bridge on `:9108`; the Grafana dashboard shows uptime,
reconnects, heartbeat latency and trade counts.

## 8. Security notes

- Broker credentials only exist on Windows, DPAPI-encrypted.
- `.env` on Ubuntu is mode `600`, owned by the service user.
- The Bridge Token authenticates the Companion; rotate it from the dashboard
  and re-run both installers with the new value.
- Only whitelisted MT5 functions (`protocol.ALLOWED_FUNCTIONS`) can be invoked
  remotely; the loopback RPC binds `127.0.0.1` only.

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Installer: "cannot reach …" | wrong dashboard URL or blocked outbound HTTPS |
| Installer: "backend rejected the Bridge Token" | copy the token again from Accounts |
| Windows: "FAIL: cannot reach ws://…" | cloud firewall port closed, or hub not running |
| `no companion for account` | Companion service stopped, or Account ID mismatch |
| Dashboard shows Connected but no trades | strategy disabled, outside session hours, or risk limits hit — see Logs |