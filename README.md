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
## 10. Backend API endpoints (dashboard domain)

These are served by the dashboard backend, never by the React SPA:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/public/bridge/heartbeat` | health probe (JSON) |
| POST | `/api/public/bridge/heartbeat` | bridge state ingestion (Bearer or `bridge_token` in body) |
| POST | `/api/public/bridge/verify` | Bridge Token check → **200** valid, **401** invalid |
| GET | `/api/public/bridge/status` | API health; with `?account_id=` + Bearer → live account status |
| GET | `/api/public/bridge/ws` | WebSocket discovery: returns the Companion Hub URL (426/501 JSON) |
| POST | `/api/public/bridge/service-logs` | Hub/Companion log ingestion for the in-app viewer |

**WebSocket:** the persistent Companion link is *not* hosted on
`danscomai.lovable.app` — the dashboard runs on an edge runtime that cannot hold
long-lived sockets. The Companion connects to your Ubuntu Companion Hub:

```
ws://<ubuntu-host>:8765            # direct
wss://<your-domain>/companion      # recommended, TLS via nginx/caddy
```

`/api/public/bridge/ws` returns exactly that guidance as JSON so installers can
fail with a clear message instead of receiving HTML.

## 11. Logging

- Hub, Bridge and Companion write rotating files (`logs/<service>.log`,
  10 MB × 5) plus journald / NSSM output.
- Ubuntu also gets `/etc/logrotate.d/mt5-bridge` (daily, 14 days, compressed).
- Warnings/errors from the last 24h are buffered in-process, exposed on the hub
  at `http://127.0.0.1:8766/logs`, shipped by the bridge to
  `/api/public/bridge/service-logs`, and shown in the dashboard under
  **Activity → Service errors (24h)**.

---

## 12. Live trading features (dashboard)

| Feature | Where | How it works |
| --- | --- | --- |
| Manual Buy/Sell | Dashboard → **Manual trade · XAUUSD** | queues an `open` command; the bridge executes it on MT5 within one poll (`POLL_SECONDS`, default 3s) and writes the retcode back |
| Close one position | Dashboard → Open positions → **Close** | queues a `close` command with the ticket |
| Close everything | Dashboard → **Close all positions** | queues `close_all` (panic button) |
| Live prices | price tiles above the trade panel | bridge pushes bid/ask/spread every heartbeat into `market_ticks`, streamed to the browser over realtime |
| Open positions / pending orders | Dashboard tables | replaced on every heartbeat, so they always mirror the terminal |
| Trade history | Dashboard table | closed deals are upserted by `(account_id, ticket)`; no duplicates on restart |
| Command status | under the trade panel | `pending → done / failed` with the MT5 result |

### Signal flow (verified end to end)

```
strategy row (enabled) ─► bridge evaluates 45-rule SMC on XAUUSD M15
                       ─► AI sentiment audit (Lovable AI) ─► capital guards
                       ─► mt5.order_send() on Windows ─► heartbeat
                       ─► positions / trade_history / snapshots ─► dashboard
manual button ─► bridge_commands (pending) ─► bridge poll ─► order_send ─► result
```

Only strategies with **rule type = SMC confluence** and **Enabled = on** trade
automatically. A strategy left on another rule type still streams prices but
never fires an order.

## 13. Capital management (safe on a $15 account)

Set per strategy under **Strategies → Capital management**:

| Setting | Default | Meaning |
| --- | --- | --- |
| Auto lot sizing | on | volume = (equity × risk %) ÷ (SL pips × pip value), rounded to the broker's lot step |
| Risk per trade | 1 % | of **live equity**, recalculated before every entry |
| Max lot | 0.01 | hard ceiling regardless of the maths |
| Equity floor | $5 | trading halts below this balance |
| Daily drawdown cap | 5 % | of the day's opening equity; halts until the next server day |
| Max margin used | 20 % | no new entry if margin would exceed this share of equity |
| Max open trades | 1 | concurrent positions per strategy |

Micro-account guard: if the broker minimum lot (usually 0.01) would risk more
than **twice** your risk % — and never more than 10 % of equity — the trade is
skipped and the reason is logged instead of blowing the account. On $15 with a
300-pip gold stop, 0.01 lots risks about $3, so the bot will trade only when the
stop distance is small enough; widen the SL or fund the account to trade more
often.

## 14. What to do on your VPS (after this update)

**Ubuntu (backend + strategy engine)**

```bash
cd /opt/mt5-bridge            # or wherever you cloned it
sudo bash install.sh --upgrade      # pulls the new bridge code + deps
sudo systemctl restart mt5-companion-hub mt5-bridge
journalctl -u mt5-bridge -f          # watch: "executing open", "SMC entry", capital guard lines
```

**Windows (Companion + MetaTrader 5)**

```powershell
cd C:\MT5Companion
.\install.ps1 -Upgrade
Get-Service MT5Companion            # must be Running, StartType Automatic
sc.exe qc MT5Companion              # confirm START_TYPE : 2 AUTO_START
Get-Content .\logs\companion.log -Tail 50 -Wait
```

24/7 reboot survival is already configured by the installer: the service is
**Automatic (Delayed Start)** with failure actions 5 s → 10 s → 30 s, and it
relaunches `terminal64.exe` and re-logs in whenever MT5 is closed or crashes.
To prove it: `Restart-Computer`, wait ~2 minutes, and the dashboard should flip
back to **Connected** on its own.

**In MetaTrader 5 (one time)**

1. Tools → Options → Expert Advisors → **Allow algorithmic trading**.
2. Toolbar **Algo Trading** button green.
3. Market Watch → right-click → Show All → confirm your gold symbol
   (`XAUUSD`, `XAUUSD.m`, `GOLD`… the bridge auto-detects the suffix).
4. Keep the terminal logged into the same account as the dashboard entry.

**Then, in the dashboard**

1. **Accounts** → account shows *Connected* with live balance/equity.
2. Price tiles show a moving bid/ask → market data is flowing.
3. Press **Buy 0.01** once on a demo account → command goes `pending → done`,
   the position appears in the table, **Close** removes it.
4. **Strategies** → open your strategy, set rule type **SMC confluence**, fill
   in the capital-management block, save, then toggle **Enabled**.
5. Watch **Activity** for `SMC entry`, `AI veto`, and capital-guard messages.

> Run at least a few sessions on a demo account before going live.
