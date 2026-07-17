#!/usr/bin/env bash
# One-click MT5 bridge installer for a fresh Ubuntu 22.04 / 24.04 server.
#
#   curl -fsSL https://raw.githubusercontent.com/<you>/<repo>/main/bridge/scripts/one-click-install.sh | sudo bash
#
# OR, from a cloned repo:
#   sudo bash bridge/scripts/one-click-install.sh
#
# Installs and configures:
#   * Wine (stable) + Python-under-Wine
#   * MetaTrader 5 terminal (silent)
#   * mt5linux RPyC server
#   * Python venv + bridge dependencies (incl. prometheus-client)
#   * systemd units: mt5linux.service, mt5-bridge.service (auto-restart)
#   * Prometheus + Grafana via Docker (dashboards auto-provisioned)
#   * cron watchdog on /tmp/mt5-bridge.health
#
# After it finishes: edit /home/mt5bridge/mt5-bridge/.env and reboot,
# or run `sudo systemctl restart mt5-bridge`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(dirname "$SCRIPT_DIR")"

log() { printf '\033[1;36m[one-click]\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }

log "1/4 running base Ubuntu installer"
bash "$SCRIPT_DIR/install-ubuntu.sh"

BRIDGE_USER="${BRIDGE_USER:-mt5bridge}"
BRIDGE_DIR="/home/${BRIDGE_USER}/mt5-bridge"

log "2/4 installing Docker (for Prometheus + Grafana)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

log "3/4 starting Prometheus + Grafana"
cd "$BRIDGE_DIR/monitoring"
docker compose -f docker-compose.monitoring.yml up -d

log "4/4 installing health watchdog (cron every minute)"
cat >/etc/cron.d/mt5-bridge-watchdog <<EOF
* * * * * root bash ${BRIDGE_DIR}/scripts/healthcheck.sh >/dev/null || systemctl restart mt5-bridge.service
EOF
chmod 644 /etc/cron.d/mt5-bridge-watchdog

systemctl daemon-reload
systemctl restart mt5linux.service mt5-bridge.service || true

IP="$(curl -s -4 ifconfig.me || echo YOUR_VPS_IP)"
cat <<EOF

========================================================================
  MT5 Bridge — installation complete
========================================================================

  Bridge dir:  ${BRIDGE_DIR}
  Env file:    ${BRIDGE_DIR}/.env   (edit before first real run)
  Services:    systemctl status mt5-bridge mt5linux
  Logs:        journalctl -u mt5-bridge -f

  Metrics:     http://${IP}:9108/metrics
  Prometheus:  http://${IP}:9090
  Grafana:     http://${IP}:3000       (login admin / admin)
               Dashboard: "MT5 / MT5 Bridge"

  Next:
   1. Log in to MT5 once so it stores broker credentials:
        sudo -u ${BRIDGE_USER} WINEPREFIX=/home/${BRIDGE_USER}/.wine-mt5 \\
          xvfb-run -a wine "/home/${BRIDGE_USER}/.wine-mt5/drive_c/Program Files/MetaTrader 5/terminal64.exe"
   2. Fill ${BRIDGE_DIR}/.env from the dashboard Accounts panel.
   3. sudo systemctl restart mt5-bridge

========================================================================
EOF