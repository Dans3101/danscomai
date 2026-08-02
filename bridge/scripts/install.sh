#!/usr/bin/env bash
# ============================================================================
#  MT5 Bridge — production installer for Ubuntu 22.04 / 24.04
# ----------------------------------------------------------------------------
#  Installs system dependencies, creates the virtualenv, installs Python
#  packages, writes/updates .env, installs + enables + starts the Companion
#  Hub and Bridge systemd services, then verifies everything is running.
#
#  Wine-free: MetaTrader 5 runs on Windows via the Windows Companion.
#
#  Usage:
#     sudo bash bridge/scripts/install.sh                  # interactive
#     sudo APP_BASE_URL=... ACCOUNT_ID=... BRIDGE_TOKEN=... \
#          bash bridge/scripts/install.sh --non-interactive
#
#  Flags:
#     --non-interactive   never prompt (all values from env / existing .env)
#     --upgrade           re-sync code + deps, keep existing .env
#     --no-start          install but do not start services
#     --uninstall         stop, disable and remove services (keeps data)
# ============================================================================
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_USER="${BRIDGE_USER:-mt5bridge}"
BRIDGE_HOME="/home/${BRIDGE_USER}"
BRIDGE_DIR="${BRIDGE_DIR:-${BRIDGE_HOME}/mt5-bridge}"
ENV_FILE="${BRIDGE_DIR}/.env"
UNITS=(mt5-companion-hub mt5-bridge)

NON_INTERACTIVE=0; UPGRADE=0; NO_START=0; UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --upgrade) UPGRADE=1 ;;
    --no-start) NO_START=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done
[[ -t 0 ]] || NON_INTERACTIVE=1

STEP=0; TOTAL=8
c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
step()  { STEP=$((STEP+1)); c '1;36' "[${STEP}/${TOTAL}] $*"; }
ok()    { c '1;32' "      ok — $*"; }
warn()  { c '1;33' "      ! $*"; }
die()   { c '1;31' "ERROR: $*"; echo; c '1;31' "Installation aborted. Nothing was started."; exit 1; }

trap 'die "unexpected failure on line $LINENO. Re-run with: sudo bash $0"' ERR

[[ $EUID -eq 0 ]] || die "run as root:  sudo bash $0"
. /etc/os-release 2>/dev/null || true
[[ "${ID:-}" == "ubuntu" || "${ID_LIKE:-}" == *debian* ]] || warn "untested distro '${ID:-unknown}' — continuing"

# ---------------------------------------------------------------- uninstall
if [[ $UNINSTALL -eq 1 ]]; then
  for u in "${UNITS[@]}"; do
    systemctl disable --now "$u" 2>/dev/null || true
    rm -f "/etc/systemd/system/${u}.service"
  done
  systemctl daemon-reload
  c '1;32' "Services removed. Code and .env kept at ${BRIDGE_DIR}."
  exit 0
fi

c '1;35' "
 ┌────────────────────────────────────────────────┐
 │  MT5 Bridge installer  ·  Ubuntu  ·  Wine-free │
 └────────────────────────────────────────────────┘"

# ------------------------------------------------------------------ 1 user
step "creating service user '${BRIDGE_USER}'"
id -u "$BRIDGE_USER" &>/dev/null || useradd -m -s /bin/bash "$BRIDGE_USER"
ok "user ready"

# ------------------------------------------------------------ 2 system deps
step "installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl rsync python3 python3-venv python3-pip coreutils jq \
  >/dev/null || die "apt-get failed — check network/DNS on this VPS"
PYV="$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
python3 -c 'import sys;raise SystemExit(0 if sys.version_info>=(3,10) else 1)' \
  || die "Python ${PYV} is too old — the bridge needs Python 3.10+"
ok "python ${PYV}, curl, jq installed"

# ------------------------------------------------------------------ 3 code
step "syncing bridge code to ${BRIDGE_DIR}"
install -d -o "$BRIDGE_USER" -g "$BRIDGE_USER" "$BRIDGE_DIR"
rsync -a --delete \
  --exclude '.venv' --exclude '__pycache__' --exclude '.env' \
  "$SRC_DIR"/ "$BRIDGE_DIR"/
chown -R "$BRIDGE_USER":"$BRIDGE_USER" "$BRIDGE_DIR"
ok "code in place"

# ----------------------------------------------------------------- 4 venv
step "creating virtualenv + installing Python packages"
[[ -x "$BRIDGE_DIR/.venv/bin/python" ]] || sudo -u "$BRIDGE_USER" python3 -m venv "$BRIDGE_DIR/.venv"
sudo -u "$BRIDGE_USER" "$BRIDGE_DIR/.venv/bin/pip" install -q --upgrade pip wheel
sudo -u "$BRIDGE_USER" "$BRIDGE_DIR/.venv/bin/pip" install -q -r "$BRIDGE_DIR/requirements.txt" \
  || die "pip install failed — see the output above"
ok "$(sudo -u "$BRIDGE_USER" "$BRIDGE_DIR/.venv/bin/pip" list --format=freeze | wc -l) packages installed"

# ------------------------------------------------------------------ 5 .env
step "configuring ${ENV_FILE}"
[[ -f "$ENV_FILE" ]] || { install -o "$BRIDGE_USER" -g "$BRIDGE_USER" -m 600 \
  "$BRIDGE_DIR/.env.example" "$ENV_FILE"; }

getenv() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'; }
setenv() {
  local k="$1" v="$2"
  if grep -qE "^${k}=" "$ENV_FILE"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
}
ask() { # ask VAR "Prompt" [default]
  local var="$1" prompt="$2" cur; cur="${!var:-$(getenv "$var")}"
  cur="${cur:-${3:-}}"
  if [[ $NON_INTERACTIVE -eq 1 || $UPGRADE -eq 1 ]]; then
    printf -v "$var" '%s' "$cur"; return
  fi
  read -r -p "      ${prompt}${cur:+ [${cur}]}: " reply || true
  printf -v "$var" '%s' "${reply:-$cur}"
}

ask APP_BASE_URL   "Dashboard URL (https://…lovable.app)"
ask ACCOUNT_ID     "Account ID (UUID from the Accounts page)"
ask BRIDGE_TOKEN   "Bridge Token (Accounts page)"
ask HUB_WS_PORT    "Companion WebSocket port" 8765

[[ -n "${APP_BASE_URL}" ]] || die "APP_BASE_URL is required (Dashboard → Accounts → Bridge config)"
[[ "${APP_BASE_URL}" =~ ^https?:// ]] || die "APP_BASE_URL must start with http:// or https://"
[[ -n "${ACCOUNT_ID}" ]]   || die "ACCOUNT_ID is required (Dashboard → Accounts)"
[[ -n "${BRIDGE_TOKEN}" ]] || die "BRIDGE_TOKEN is required (Dashboard → Accounts → Bridge config)"

APP_BASE_URL="${APP_BASE_URL%/}"
setenv APP_BASE_URL   "$APP_BASE_URL"
setenv ACCOUNT_ID     "$ACCOUNT_ID"
setenv BRIDGE_TOKEN   "$BRIDGE_TOKEN"
setenv COMPANION_TOKENS "$(getenv COMPANION_TOKENS || true)"
[[ -n "$(getenv COMPANION_TOKENS)" ]] || setenv COMPANION_TOKENS "$BRIDGE_TOKEN"
setenv HUB_WS_PORT    "${HUB_WS_PORT:-8765}"
setenv MT5_BACKEND    "$(getenv MT5_BACKEND || echo auto)"
[[ -n "$(getenv MT5_BACKEND)" ]] || setenv MT5_BACKEND auto
chown "$BRIDGE_USER":"$BRIDGE_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"
ok "configuration written (mode 600, owner ${BRIDGE_USER})"

# ------------------------------------------------------- 6 backend reachable
step "verifying the dashboard backend is reachable"
HB_URL="${APP_BASE_URL}/api/public/bridge/heartbeat"
CODE="$(curl -s -o /tmp/mt5-hb.out -w '%{http_code}' --max-time 20 -X POST "$HB_URL" \
  -H 'content-type: application/json' \
  -d "{\"account_id\":\"${ACCOUNT_ID}\",\"bridge_token\":\"${BRIDGE_TOKEN}\",\"connection_status\":\"connecting\"}" || echo 000)"
case "$CODE" in
  200|201|204) ok "backend accepted the heartbeat (HTTP $CODE)" ;;
  401|403) die "backend rejected the Bridge Token (HTTP $CODE). Copy it again from Dashboard → Accounts → Bridge config." ;;
  404) die "endpoint not found at ${HB_URL}. Check APP_BASE_URL (must be your published dashboard URL)." ;;
  000) die "cannot reach ${APP_BASE_URL} — DNS/firewall/outbound HTTPS blocked on this VPS." ;;
  *)   warn "backend answered HTTP $CODE: $(head -c 200 /tmp/mt5-hb.out). Continuing — the bridge retries automatically." ;;
esac
rm -f /tmp/mt5-hb.out

# --------------------------------------------------------------- 7 services
step "installing systemd services"
for unit in "${UNITS[@]}"; do
  sed -e "s|__USER__|${BRIDGE_USER}|g" -e "s|__BRIDGE_DIR__|${BRIDGE_DIR}|g" \
    "$BRIDGE_DIR/systemd/${unit}.service" > "/etc/systemd/system/${unit}.service"
done
systemctl daemon-reload
systemctl enable -q "${UNITS[@]}"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q active; then
  ufw allow "$(getenv HUB_WS_PORT)/tcp" >/dev/null 2>&1 || true
  ok "ufw: opened $(getenv HUB_WS_PORT)/tcp for the Windows Companion"
fi
if [[ $NO_START -eq 1 ]]; then
  ok "services enabled (not started, --no-start)"
else
  systemctl restart "${UNITS[@]}"
  ok "services enabled and started"
fi

# ----------------------------------------------------------------- 8 verify
step "verifying the installation"
FAIL=0
if [[ $NO_START -eq 0 ]]; then
  sleep 4
  for u in "${UNITS[@]}"; do
    if systemctl is-active --quiet "$u"; then ok "$u active"
    else
      FAIL=1; c '1;31' "      ✗ $u failed to start:"
      journalctl -u "$u" -n 15 --no-pager | sed 's/^/        /'
    fi
  done
  RPC_PORT="$(getenv HUB_RPC_PORT)"; RPC_PORT="${RPC_PORT:-8766}"
  for i in $(seq 1 15); do
    if curl -sf "http://127.0.0.1:${RPC_PORT}/health" >/dev/null; then
      ok "hub RPC healthy on 127.0.0.1:${RPC_PORT}"; break
    fi
    [[ $i -eq 15 ]] && { FAIL=1; c '1;31' "      ✗ hub RPC not answering on 127.0.0.1:${RPC_PORT}"; }
    sleep 1
  done
  COMP="$(curl -sf "http://127.0.0.1:${RPC_PORT}/health" | jq -r '.companions // 0' 2>/dev/null || echo 0)"
  [[ "$COMP" -gt 0 ]] && ok "${COMP} Windows Companion(s) connected" \
                      || warn "no Windows Companion connected yet — run the Windows installer next"
fi
[[ $FAIL -eq 0 ]] || die "one or more services are unhealthy (logs above)"

trap - ERR
IP="$(curl -s --max-time 5 ifconfig.me || hostname -I | awk '{print $1}')"
cat <<EOF

$(c '1;32' '════════ MT5 Bridge installed and running ════════')

  Ubuntu side is live. Next: the Windows Companion.

  1. Open the cloud firewall for TCP $(getenv HUB_WS_PORT) (or 443 if you proxy TLS).
  2. On the Windows machine (with MetaTrader 5 installed), run PowerShell
     as Administrator inside the windows-companion folder:

       powershell -ExecutionPolicy Bypass -File install.ps1

     Backend URL to enter:  ws://${IP}:$(getenv HUB_WS_PORT)
                            wss://your-domain/companion   (recommended, TLS)
     Bridge Token:          the same token you entered here

  Useful commands
     systemctl status mt5-companion-hub mt5-bridge
     journalctl -u mt5-bridge -f
     curl -s http://127.0.0.1:$(getenv HUB_RPC_PORT || echo 8766)/status | jq
     sudo bash $0 --upgrade      # pull new code + deps, keep config
     sudo bash $0 --uninstall    # remove services

EOF