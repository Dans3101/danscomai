# MT5 Bridge

Runs on a Windows VPS (MT5 terminal is Windows-only) or a Windows container.
Connects to your MT5 terminal, streams state to the dashboard, and executes
queued commands.

## Architecture

```
 MT5 terminal  <->  EA (mt5_autotrader.mq5)         (in-terminal)
       |                     |
       +------ MT5 lib ------+
                |
                v
       Python bridge  ---> https://YOUR-APP/api/public/bridge/heartbeat
                       <---  /api/public/bridge/commands
```

The Python service does the heavy lifting (account state, order placement,
strategy evaluation). The EA is a lightweight tick streamer / fallback.

## Setup on Windows VPS

1. Install MetaTrader 5 for your broker and log in once manually.
2. Install Python 3.11 (Windows).
3. `pip install -r bridge/requirements.txt`
4. Copy `.env.example` to `.env` and paste the values from the app's
   **Accounts -> Bridge config** panel.
5. `python bridge/main.py`

## Setup on Render (Docker)

MT5's official `MetaTrader5` PyPI package requires Windows. To run on Render
you must either use a **Windows** container or run the bridge in a Wine-based
image (community images exist; not officially supported by MetaQuotes).
See `Dockerfile.wine` for a reference. Reliability on Wine is your
responsibility.

## The EA

Copy `mt5_autotrader.mq5` into your MT5 `MQL5/Experts` folder, compile it in
MetaEditor, and attach to any chart. It reads/writes files in the
`Common\Files` folder that the Python bridge polls, giving you a tick stream
even when running MT5 headless.

## Security

- The `BRIDGE_TOKEN` in `.env` is a random opaque string tied to one account.
  Anyone with it can post trades to that account. Do not commit `.env`.
- MT5 credentials are stored **encrypted** in the app database. The bridge
  never sends them back to the app.