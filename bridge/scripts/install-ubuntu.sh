#!/usr/bin/env bash
# One-shot installer for the MT5 bridge on Ubuntu 22.04 / 24.04.
#
# Installs: Wine (stable), Python 3.11+, mt5linux, RPyC, the bridge
# service, and the MetaTrader 5 terminal (headless installer).
#
# Works on any Ubuntu VPS (Oracle Cloud Always Free, GCP, AWS EC2, Azure,
# Contabo, Hetzner, DigitalOcean, Vultr, Linode, ...). Requires sudo.
#
# Usage:  sudo bash scripts/install-ubuntu.sh
set -euo pipefail

BRIDGE_USER="${BRIDGE_USER:-mt5bridge}"
BRIDGE_HOME="/home/${BRIDGE_USER}"
BRIDGE_DIR="${BRIDGE_HOME}/mt5-bridge"
WINEPREFIX="${BRIDGE_HOME}/.wine-mt5"
MT5_URL="https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe"

log() { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "run with sudo"; exit 1
fi

log "creating service user ${BRIDGE_USER}"
id -u "$BRIDGE_USER" &>/dev/null || useradd -m -s /bin/bash "$BRIDGE_USER"

log "adding i386 arch + Wine repo"
dpkg --add-architecture i386
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg wget xvfb xauth \
  python3 python3-pip python3-venv \
  software-properties-common cabextract unzip

mkdir -p /etc/apt/keyrings
wget -qO- https://dl.winehq.org/wine-builds/winehq.key | gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key
CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
wget -qO /etc/apt/sources.list.d/winehq.sources \
  "https://dl.winehq.org/wine-builds/ubuntu/dists/${CODENAME}/winehq-${CODENAME}.sources"
apt-get update -y
apt-get install -y --install-recommends winehq-stable || apt-get install -y wine wine64 wine32

log "creating Wine prefix"
sudo -u "$BRIDGE_USER" WINEPREFIX="$WINEPREFIX" WINEARCH=win64 wineboot -i || true

log "installing Python for Wine (needed by mt5linux server)"
PYWIN_URL="https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"
sudo -u "$BRIDGE_USER" bash -c "cd /tmp && curl -L -o py.exe '$PYWIN_URL' && \
  WINEPREFIX='$WINEPREFIX' xvfb-run -a wine py.exe /quiet InstallAllUsers=1 PrependPath=1 || true"
sudo -u "$BRIDGE_USER" WINEPREFIX="$WINEPREFIX" xvfb-run -a wine python -m pip install --upgrade pip MetaTrader5 mt5linux rpyc || true

log "downloading MetaTrader 5 terminal"
sudo -u "$BRIDGE_USER" bash -c "curl -L -o /tmp/mt5setup.exe '$MT5_URL'"
log "installing MT5 terminal (silent)"
sudo -u "$BRIDGE_USER" WINEPREFIX="$WINEPREFIX" xvfb-run -a wine /tmp/mt5setup.exe /auto || true

log "installing bridge Python deps (Linux side)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(dirname "$SCRIPT_DIR")"
install -d -o "$BRIDGE_USER" -g "$BRIDGE_USER" "$BRIDGE_DIR"
cp -r "$SRC_DIR"/. "$BRIDGE_DIR"/
chown -R "$BRIDGE_USER:$BRIDGE_USER" "$BRIDGE_DIR"
sudo -u "$BRIDGE_USER" python3 -m venv "$BRIDGE_DIR/.venv"
sudo -u "$BRIDGE_USER" "$BRIDGE_DIR/.venv/bin/pip" install --upgrade pip
sudo -u "$BRIDGE_USER" "$BRIDGE_DIR/.venv/bin/pip" install -r "$BRIDGE_DIR/requirements.txt"

if [[ ! -f "$BRIDGE_DIR/.env" ]]; then
  cp "$BRIDGE_DIR/.env.example" "$BRIDGE_DIR/.env"
  chown "$BRIDGE_USER:$BRIDGE_USER" "$BRIDGE_DIR/.env"
  chmod 600 "$BRIDGE_DIR/.env"
fi

log "installing systemd units"
install -m 644 "$BRIDGE_DIR/systemd/mt5linux.service" /etc/systemd/system/
install -m 644 "$BRIDGE_DIR/systemd/mt5-bridge.service" /etc/systemd/system/
sed -i "s|__USER__|$BRIDGE_USER|g; s|__BRIDGE_DIR__|$BRIDGE_DIR|g; s|__WINEPREFIX__|$WINEPREFIX|g" \
  /etc/systemd/system/mt5linux.service /etc/systemd/system/mt5-bridge.service

systemctl daemon-reload
systemctl enable mt5linux.service mt5-bridge.service

cat <<EOF

[install] done.

Next steps:
  1. Edit ${BRIDGE_DIR}/.env with your APP_BASE_URL, ACCOUNT_ID, BRIDGE_TOKEN,
     MT5_LOGIN, MT5_PASSWORD, MT5_SERVER (from the dashboard Accounts panel).
  2. Log in to the MT5 terminal ONCE so it stores the broker connection:
       sudo -u ${BRIDGE_USER} WINEPREFIX=${WINEPREFIX} xvfb-run -a wine \\
         "${WINEPREFIX}/drive_c/Program Files/MetaTrader 5/terminal64.exe"
  3. Start the services:
       sudo systemctl start mt5linux.service mt5-bridge.service
       sudo systemctl status mt5-bridge.service
       journalctl -u mt5-bridge.service -f
EOF