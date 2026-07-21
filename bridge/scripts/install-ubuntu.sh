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
# Hard caps so a stuck Wine child can never block the installer forever.
PYWIN_INSTALL_TIMEOUT="${PYWIN_INSTALL_TIMEOUT:-600}"   # 10 min
WINEBOOT_TIMEOUT="${WINEBOOT_TIMEOUT:-300}"             # 5 min

log() { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install:warn]\033[0m %s\n' "$*"; }

# Run a command as the bridge user under Xvfb+Wine with a hard timeout.
# Any non-zero exit (including timeout / GUI-installer hang) is logged
# and swallowed so the installer keeps moving — the bridge itself
# validates MT5 at runtime and can also run in simulator mode.
run_wine() {
  local timeout_s="$1"; shift
  local label="$1"; shift
  log "wine step: ${label} (timeout ${timeout_s}s)"
  if sudo -u "$BRIDGE_USER" \
       WINEPREFIX="$WINEPREFIX" WINEARCH=win64 WINEDEBUG=-all \
       DISPLAY="" \
       timeout --preserve-status --kill-after=30s "${timeout_s}s" \
       xvfb-run -a -e /dev/stderr "$@"; then
    log "wine step ok: ${label}"
  else
    warn "wine step '${label}' exited non-zero (continuing)"
  fi
}

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
  software-properties-common cabextract unzip coreutils

mkdir -p /etc/apt/keyrings
wget -qO- https://dl.winehq.org/wine-builds/winehq.key | gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key
CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
wget -qO /etc/apt/sources.list.d/winehq.sources \
  "https://dl.winehq.org/wine-builds/ubuntu/dists/${CODENAME}/winehq-${CODENAME}.sources"
apt-get update -y
apt-get install -y --install-recommends winehq-stable || apt-get install -y wine wine64 wine32

log "creating Wine prefix"
install -d -o "$BRIDGE_USER" -g "$BRIDGE_USER" "$WINEPREFIX"
run_wine "$WINEBOOT_TIMEOUT" "wineboot -i" wineboot -i
# Wine spawns background services (wineserver, mscorsvc, etc.). Give
# them a moment to settle so the next wine invocation doesn't race the
# prefix bring-up and appear to hang.
sudo -u "$BRIDGE_USER" WINEPREFIX="$WINEPREFIX" wineserver -w || true

log "installing Python for Wine (needed by mt5linux server)"
PYWIN_URL="https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"
PYWIN_EXE="/tmp/py-win-installer.exe"
# Download as the bridge user so file perms are consistent, and do the
# download OUTSIDE the wine timeout so slow networks don't eat the budget.
sudo -u "$BRIDGE_USER" curl -fL --retry 3 --retry-delay 5 -o "$PYWIN_EXE" "$PYWIN_URL"
# /quiet + InstallAllUsers=1 + PrependPath=1 is the documented silent
# install flag set for python.org installers. Each flag is a separate
# argv entry — do NOT collapse into one string, or Wine sees a single
# unknown arg and drops back to the interactive GUI (which then hangs).
run_wine "$PYWIN_INSTALL_TIMEOUT" "python-for-wine installer" \
  wine "$PYWIN_EXE" /quiet InstallAllUsers=1 PrependPath=1 Include_launcher=0 Include_test=0

# Install Windows-side pip packages. `wine python -m pip ...` — arguments
# passed as separate argv entries so wine doesn't concatenate them.
run_wine "$PYWIN_INSTALL_TIMEOUT" "pip upgrade + MetaTrader5/mt5linux/rpyc" \
  wine python -m pip install --no-input --disable-pip-version-check \
    --upgrade pip MetaTrader5 mt5linux rpyc

log "downloading MetaTrader 5 terminal installer (for manual install)"
MT5_EXE="/tmp/mt5setup.exe"
sudo -u "$BRIDGE_USER" curl -fL --retry 3 --retry-delay 5 -o "$MT5_EXE" "$MT5_URL" || \
  warn "MT5 installer download failed — re-download manually before step 2 below."
chown "$BRIDGE_USER:$BRIDGE_USER" "$MT5_EXE" 2>/dev/null || true

log "SKIPPING unattended MT5 install (unreliable under Xvfb on some VPS providers)."
log "You will install MT5 manually — instructions printed at the end of this script."

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

Wine + Python-for-Wine + mt5linux + bridge deps are installed.
MT5 terminal was NOT installed (skipped by design — Xvfb-driven silent
install is unreliable on some cloud VPS providers). Install it manually:

  1. Install MT5 terminal under Wine (run this on the VPS; keep the SSH
     session open until the wizard finishes — press Next/Install/Finish):

       sudo -u ${BRIDGE_USER} \\
         WINEPREFIX=${WINEPREFIX} WINEARCH=win64 WINEDEBUG=-all \\
         xvfb-run -a -s "-screen 0 1280x800x24" \\
         wine /tmp/mt5setup.exe

     If /tmp/mt5setup.exe is missing, re-download it:
       sudo -u ${BRIDGE_USER} curl -fL --retry 3 -o /tmp/mt5setup.exe \\
         "${MT5_URL}"

  2. Verify terminal64.exe exists (this MUST print a path):

       ls -l "${WINEPREFIX}/drive_c/Program Files/MetaTrader 5/terminal64.exe"

     If missing, MT5 didn't finish installing — re-run step 1.

  3. Log in to MT5 once so it stores your broker connection:

       sudo -u ${BRIDGE_USER} WINEPREFIX=${WINEPREFIX} xvfb-run -a wine \\
         "${WINEPREFIX}/drive_c/Program Files/MetaTrader 5/terminal64.exe"

  4. Edit ${BRIDGE_DIR}/.env with APP_BASE_URL, ACCOUNT_ID, BRIDGE_TOKEN,
     MT5_LOGIN, MT5_PASSWORD, MT5_SERVER (from the dashboard Accounts panel).

  5. Start the services:
       sudo systemctl start mt5linux.service mt5-bridge.service
       sudo systemctl status mt5-bridge.service
       journalctl -u mt5-bridge.service -f
EOF