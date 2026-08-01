#!/usr/bin/env bash
# Installer for the MT5 backend on Ubuntu 22.04 / 24.04.
#
# Phase 1 architecture: NO Wine, NO Xvfb, NO mt5linux, NO MT5 terminal on
# Linux. Ubuntu runs the trading logic plus the Companion Hub; MetaTrader 5
# itself runs on a Windows host via the Windows Companion Service, which
# connects out to this server over a persistent TLS WebSocket.
#
# Usage:  sudo bash scripts/install-ubuntu.sh
set -euo pipefail

BRIDGE_USER="${BRIDGE_USER:-mt5bridge}"
BRIDGE_HOME="/home/${BRIDGE_USER}"
BRIDGE_DIR="${BRIDGE_HOME}/mt5-bridge"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB_WS_PORT="${HUB_WS_PORT:-8765}"

log() { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install:warn]\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "run with sudo"; exit 1
fi

log "creating service user ${BRIDGE_USER}"
id -u "$BRIDGE_USER" &>/dev/null || useradd -m -s /bin/bash "$BRIDGE_USER"

log "installing base packages"
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl python3 python3-pip python3-venv coreutils

log "copying bridge sources to ${BRIDGE_DIR}"
install -d -o "$BRIDGE_USER" -g "$BRIDGE_USER" "$BRIDGE_DIR"
rsync -a --exclude '.venv' --exclude '__pycache__' "$SRC_DIR"/ "$BRIDGE_DIR"/ 2>/dev/null || \
  cp -r "$SRC_DIR"/. "$BRIDGE_DIR"/
chown -R "$BRIDGE_USER":"$BRIDGE_USER" "$BRIDGE_DIR"

log "creating python venv + installing dependencies"
sudo -u "$BRIDGE_USER" python3 -m venv "$BRIDGE_DIR/.venv"
sudo -u "$BRIDGE_USER" "$BRIDGE_DIR/.venv/bin/pip" install --upgrade pip
sudo -u "$BRIDGE_USER" "$BRIDGE_DIR/.venv/bin/pip" install -r "$BRIDGE_DIR/requirements.txt"

if [[ ! -f "$BRIDGE_DIR/.env" ]]; then
  log "creating .env template"
  sudo -u "$BRIDGE_USER" cp "$BRIDGE_DIR/.env.example" "$BRIDGE_DIR/.env"
  chmod 600 "$BRIDGE_DIR/.env"
  warn "edit ${BRIDGE_DIR}/.env with values from the dashboard Accounts panel"
fi

log "installing systemd units"
for unit in mt5-companion-hub mt5-bridge; do
  sed -e "s|__USER__|${BRIDGE_USER}|g" -e "s|__BRIDGE_DIR__|${BRIDGE_DIR}|g" \
    "$BRIDGE_DIR/systemd/${unit}.service" > "/etc/systemd/system/${unit}.service"
done
systemctl daemon-reload
systemctl enable mt5-companion-hub mt5-bridge

if command -v ufw >/dev/null 2>&1; then
  log "allowing companion WebSocket port ${HUB_WS_PORT}/tcp in ufw"
  ufw allow "${HUB_WS_PORT}/tcp" || true
fi

cat <<EOF

============================================================
 Ubuntu backend installed (Wine-free).
============================================================

1. Edit ${BRIDGE_DIR}/.env
     APP_BASE_URL, ACCOUNT_ID, BRIDGE_TOKEN, COMPANION_TOKENS

2. Start the services:
     sudo systemctl start mt5-companion-hub mt5-bridge
     journalctl -u mt5-companion-hub -f

3. Terminate TLS in front of the hub (recommended) with nginx/caddy:
     wss://your-host/companion  ->  http://127.0.0.1:${HUB_WS_PORT}
   or set HUB_TLS_CERT / HUB_TLS_KEY in .env to let the hub serve TLS
   directly on port ${HUB_WS_PORT}.
   Cloud firewall: open ${HUB_WS_PORT}/tcp (or 443 when proxied).

4. On the WINDOWS machine, copy the windows-companion/ folder, fill in
   config.json (backend_ws_url + bridge_token + up to 3 accounts) and run:
     powershell -ExecutionPolicy Bypass -File run.ps1

5. Verify the link:
     curl -s http://127.0.0.1:${HUB_RPC_PORT:-8766}/status | python3 -m json.tool

EOF