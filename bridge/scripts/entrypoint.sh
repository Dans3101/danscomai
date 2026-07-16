#!/usr/bin/env bash
# Container/service entrypoint: start Xvfb + mt5linux RPyC server, then run
# the bridge. Any subprocess crash brings the container down so the
# orchestrator (Docker/systemd/K8s) restarts everything cleanly.
set -euo pipefail

cleanup() { kill $(jobs -p) 2>/dev/null || true; }
trap cleanup EXIT

if [[ "${MT5_BACKEND:-auto}" != "simulator" ]]; then
  echo "[entrypoint] starting Xvfb"
  Xvfb :99 -screen 0 1280x800x24 &
  sleep 1

  echo "[entrypoint] starting mt5linux server"
  wine python -m mt5linux --host 127.0.0.1 --port "${MT5LINUX_PORT:-18812}" wine python &
  sleep 3
fi

echo "[entrypoint] starting bridge"
exec /home/mt5/.venv/bin/python main.py