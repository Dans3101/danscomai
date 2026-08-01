# Windows Companion Service (Phase 1)

Runs MetaTrader 5 **natively on Windows** for up to **3 accounts** and keeps a
single persistent, auto-reconnecting **WebSocket over TLS** open to the Ubuntu
backend. No Wine, no Xvfb, no inbound ports on the Windows host.

```
Ubuntu backend                          Windows host
 dashboard/API  ─ bridge/main.py
                  └ remote_mt5 ─ hub ◀──wss──▶ companion.py
                                                 ├ worker (account 1) ─ MT5
                                                 ├ worker (account 2) ─ MT5
                                                 └ worker (account 3) ─ MT5
```

## Setup

1. Install Python 3.11+ and MetaTrader 5 on the Windows machine.
2. Copy this folder to the Windows host.
3. `copy config.example.json config.json` and fill in:
   - `backend_ws_url` — `wss://<your-ubuntu-host>/companion`
   - `bridge_token` — the Bridge Token shown in the dashboard Accounts panel
   - one `accounts[]` entry per MT5 account (max 3) with `account_id`
     (the dashboard account UUID), `login`, `password`, `server`
4. `powershell -ExecutionPolicy Bypass -File run.ps1`

## Multiple accounts

The MetaTrader5 Python package binds one terminal per process, so each account
gets its own worker process. For 2–3 accounts, install separate **portable**
MT5 copies (e.g. `C:\MT5\acct1`, `C:\MT5\acct2`) and set `terminal_path` +
`"portable": true` per account.

## Behaviour

- **MT5 closed?** The worker launches `terminal64.exe` via `mt5.initialize(path=...)`.
- **MT5 or broker drops?** The worker reconnects on the next healthcheck (10s).
- **Internet drops?** The companion reconnects to the backend with exponential
  backoff (2s → 60s) and resumes serving commands immediately.
- **Worker process dies?** The supervisor restarts it automatically.

## Security

- Outbound-only connection; the Windows host exposes nothing.
- Authentication is the Bridge Token, sent in the `hello` frame; the hub drops
  unknown tokens immediately.
- Only whitelisted MT5 functions (`protocol.ALLOWED_FUNCTIONS`) can be invoked.
- `config.json` holds broker credentials — keep it readable only by the
  service account and never commit it.

## Not in Phase 1

Auto-updates, MSI installer, clustering, analytics, >3 accounts.