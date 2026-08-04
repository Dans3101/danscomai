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
# Prompting source. When the script is piped (curl | sudo bash) stdin is the
# script itself — reading from it swallows the rest of the file and the
# installer appears to "exit" silently right after the last prompt.
# Always prompt from the real terminal when one exists.
TTY_IN=""
if [[ -t 0 ]]; then
  TTY_IN="/dev/stdin"
elif [[ -r /dev/tty ]] && : >/dev/tty 2>/dev/null; then
  TTY_IN="/dev/tty"
fi
[[ -n "$TTY_IN" ]] || NON_INTERACTIVE=1

STEP=0; TOTAL=9
c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
step()  { STEP=$((STEP+1)); LAST_STEP="$*"; c '1;36' "[${STEP}/${TOTAL}] $*"; }
ok()    { c '1;32' "      ok — $*"; }
warn()  { c '1;33' "      ! $*"; }
die()   { FINISHED=1; c '1;31' "ERROR: $*"; echo; c '1;31' "Installation aborted. Nothing was started."; exit 1; }

FINISHED=0
LAST_STEP="startup"
trap 'rc=$?; FINISHED=1; c "1;31" "ERROR: unexpected failure at step ${STEP}/${TOTAL} (${LAST_STEP}), line ${LINENO}: ${BASH_COMMAND} (exit ${rc})"; exit "$rc"' ERR
# Catch any silent early exit (e.g. a command swallowing stdin) so the user
# never sees the installer simply stop with no explanation.
trap '[[ $FINISHED -eq 1 ]] || { c "1;31" "ERROR: installer stopped unexpectedly after step ${STEP}/${TOTAL} (${LAST_STEP})."; c "1;33" "      Re-run and capture output:  sudo bash '"$0"' --upgrade 2>&1 | tee /tmp/mt5-install.log"; }' EXIT

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

# -------------------------------------------------------------- 2b preflight
step "preflight checks (privileges, DNS, ports, firewall, certificates)"
PRE_FAIL=0

# DNS + outbound HTTPS
if command -v getent >/dev/null && ! getent hosts lovable.app >/dev/null 2>&1; then
  warn "DNS lookup for lovable.app failed — check /etc/resolv.conf"
fi
curl -sf --max-time 10 -o /dev/null https://api.github.com >/dev/null 2>&1 \
  && ok "outbound HTTPS works" \
  || { warn "outbound HTTPS to the internet seems blocked — the bridge cannot reach the dashboard"; PRE_FAIL=1; }

# Port availability for the Companion Hub + loopback RPC
PRE_WS_PORT="${HUB_WS_PORT:-$(grep -E '^HUB_WS_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)}"
PRE_WS_PORT="${PRE_WS_PORT:-8765}"
[[ "$PRE_WS_PORT" =~ ^[0-9]+$ ]] || PRE_WS_PORT=8765
PRE_RPC_PORT="${HUB_RPC_PORT:-8766}"
[[ "$PRE_RPC_PORT" =~ ^[0-9]+$ ]] || PRE_RPC_PORT=8766
port_busy() {
  if command -v ss >/dev/null 2>&1; then ss -ltn "( sport = :$1 )" 2>/dev/null | tail -n +2 | grep -q .; else return 1; fi
}
for prt in "$PRE_WS_PORT" "$PRE_RPC_PORT"; do
  if port_busy "$prt"; then
    OWNER="$(ss -ltnp "( sport = :$prt )" 2>/dev/null | tail -n +2 | sed 's/.*users:((//' | cut -d, -f1)"
    if systemctl is-active --quiet mt5-companion-hub; then
      ok "port ${prt} in use by our own hub (will be restarted)"
    else
      die "port ${prt} is already in use by ${OWNER:-another process}. Free it or set HUB_WS_PORT/HUB_RPC_PORT in ${ENV_FILE}."
    fi
  else
    ok "port ${prt} is free"
  fi
done

# Firewall
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q active; then
  ufw status | grep -q "${PRE_WS_PORT}" \
    && ok "ufw already allows ${PRE_WS_PORT}/tcp" \
    || warn "ufw is active and ${PRE_WS_PORT}/tcp is not allowed yet — this installer will open it"
else
  warn "ufw inactive — make sure the CLOUD firewall allows TCP ${PRE_WS_PORT} inbound from your Windows host"
fi

# TLS certificates (only when the hub is asked to terminate TLS itself)
CERT="$(grep -E '^HUB_TLS_CERT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
KEY="$(grep -E '^HUB_TLS_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
if [[ -n "$CERT" || -n "$KEY" ]]; then
  [[ -r "$CERT" ]] || die "HUB_TLS_CERT '$CERT' is missing or unreadable"
  [[ -r "$KEY"  ]] || die "HUB_TLS_KEY '$KEY' is missing or unreadable"
  if command -v openssl >/dev/null 2>&1; then
    END="$(openssl x509 -enddate -noout -in "$CERT" 2>/dev/null | cut -d= -f2)"
    openssl x509 -checkend 604800 -noout -in "$CERT" >/dev/null 2>&1 \
      && ok "TLS certificate valid (expires ${END})" \
      || warn "TLS certificate expires within 7 days (${END}) — renew it"
  fi
else
  warn "no HUB_TLS_CERT/HUB_TLS_KEY set — the hub will listen on plain ws://. Put nginx/caddy in front for wss:// (recommended)."
fi

# Disk + memory sanity
AVAIL_MB=$(df -Pm "$(dirname "$BRIDGE_DIR")" | awk 'NR==2{print $4}')
[[ "${AVAIL_MB:-0}" -ge 512 ]] || warn "only ${AVAIL_MB}MB free disk — logs and the venv need ~500MB"
[[ $PRE_FAIL -eq 0 ]] || warn "preflight reported issues above; continuing (services retry automatically)"

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
# repair a previously malformed .env: CRLF, joined KEY=VAL pairs, missing EOF newline
sed -i 's/\r$//' "$ENV_FILE"
awk '{s=$0; while(1){ e=index(s,"="); if(e==0 || substr(s,1,e-1) !~ /^[A-Z][A-Z0-9_]*$/){print s; break} rest=substr(s,e+1); if(match(rest,/[A-Z][A-Z0-9_]*=/)){p=e+RSTART; print substr(s,1,p-1); s=substr(s,p)} else {print s; break} }}' \
  "$ENV_FILE" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "$ENV_FILE"
[[ -z "$(tail -c 1 "$ENV_FILE")" ]] || printf '\n' >> "$ENV_FILE"
setenv() {
  local k="$1" v="$2"
  # guarantee the file ends with a newline so appends never join two vars
  if [[ -s "$ENV_FILE" ]] && [[ -n "$(tail -c 1 "$ENV_FILE")" ]]; then
    printf '\n' >> "$ENV_FILE"
  fi
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
  local reply=""
  # Read from the terminal, never from the script's own stdin.
  read -r -p "      ${prompt}${cur:+ [${cur}]}: " reply < "$TTY_IN" || true
  printf -v "$var" '%s' "${reply:-$cur}"
}

ask APP_BASE_URL   "Dashboard URL (https://…lovable.app)"
ask ACCOUNT_ID     "Account ID (UUID from the Accounts page)"
ask BRIDGE_TOKEN   "Bridge Token (Accounts page)"
ask HUB_WS_PORT    "Companion WebSocket PORT NUMBER only (e.g. 8765)" 8765
ask COMPANION_WS_URL "Public Companion WebSocket URL (optional, e.g. wss://host/companion)" ""

[[ -n "${APP_BASE_URL}" ]] || die "APP_BASE_URL is required (Dashboard → Accounts → Bridge config)"
[[ "${APP_BASE_URL}" =~ ^https?:// ]] || die "APP_BASE_URL must start with http:// or https://"
[[ -n "${ACCOUNT_ID}" ]]   || die "ACCOUNT_ID is required (Dashboard → Accounts)"
[[ -n "${BRIDGE_TOKEN}" ]] || die "BRIDGE_TOKEN is required (Dashboard → Accounts → Bridge config)"

# HUB_WS_PORT must be an integer. If a URL was pasted, extract its port (or
# fall back to 8765) and keep the URL in COMPANION_WS_URL instead.
if [[ ! "${HUB_WS_PORT}" =~ ^[0-9]+$ ]]; then
  if [[ "${HUB_WS_PORT}" =~ ^(ws|wss|http|https):// ]]; then
    [[ -n "${COMPANION_WS_URL}" ]] || COMPANION_WS_URL="${HUB_WS_PORT}"
    EXTRACTED="$(printf '%s' "${HUB_WS_PORT}" | sed -nE 's|^[a-z]+://[^/:]+:([0-9]+).*|\1|p')"
    HUB_WS_PORT="${EXTRACTED:-8765}"
    warn "a URL was given for the port — stored it as COMPANION_WS_URL and using HUB_WS_PORT=${HUB_WS_PORT}"
  else
    warn "invalid HUB_WS_PORT '${HUB_WS_PORT}' — falling back to 8765"
    HUB_WS_PORT=8765
  fi
fi
[[ "${HUB_WS_PORT}" -ge 1 && "${HUB_WS_PORT}" -le 65535 ]] || die "HUB_WS_PORT must be between 1 and 65535"

APP_BASE_URL="${APP_BASE_URL%/}"
setenv APP_BASE_URL   "$APP_BASE_URL"
setenv ACCOUNT_ID     "$ACCOUNT_ID"
setenv BRIDGE_TOKEN   "$BRIDGE_TOKEN"
setenv COMPANION_TOKENS "$(getenv COMPANION_TOKENS || true)"
[[ -n "$(getenv COMPANION_TOKENS)" ]] || setenv COMPANION_TOKENS "$BRIDGE_TOKEN"
setenv HUB_WS_PORT    "${HUB_WS_PORT}"
[[ -z "${COMPANION_WS_URL}" ]] || setenv COMPANION_WS_URL "${COMPANION_WS_URL}"
setenv MT5_BACKEND    "$(getenv MT5_BACKEND || echo auto)"
[[ -n "$(getenv MT5_BACKEND)" ]] || setenv MT5_BACKEND auto
setenv LOG_DIR "${BRIDGE_DIR}/logs"
# final sanity pass: no stray joined lines, no CRLF
sed -i 's/\r$//' "$ENV_FILE"
grep -qE '^HUB_WS_PORT=[0-9]+$' "$ENV_FILE" || die "generated .env has an invalid HUB_WS_PORT — inspect ${ENV_FILE}"
chown "$BRIDGE_USER":"$BRIDGE_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"
ok "configuration written (mode 600, owner ${BRIDGE_USER})"

# ------------------------------------------------------- 6 backend reachable
step "verifying the dashboard backend is reachable"
VERIFY_URL="${APP_BASE_URL}/api/public/bridge/verify"
VCODE="$(curl -s -o /tmp/mt5-verify.out -w '%{http_code}' --max-time 20 -X POST "$VERIFY_URL" \
  -H 'content-type: application/json' \
  -d "{\"account_id\":\"${ACCOUNT_ID}\",\"bridge_token\":\"${BRIDGE_TOKEN}\"}" || echo 000)"
case "$VCODE" in
  200) ok "bridge token verified by the backend" ;;
  401) die "backend rejected the Bridge Token (HTTP 401). Copy Account ID + Bridge Token again from Dashboard → Accounts → Bridge config." ;;
  404) die "verify endpoint not found at ${VERIFY_URL}. Publish the dashboard, then re-run this installer." ;;
  000) die "cannot reach ${APP_BASE_URL} — DNS/firewall/outbound HTTPS blocked on this VPS." ;;
  *)   warn "verify endpoint answered HTTP ${VCODE}: $(head -c 200 /tmp/mt5-verify.out)" ;;
esac
rm -f /tmp/mt5-verify.out
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
install -d -o "$BRIDGE_USER" -g "$BRIDGE_USER" -m 750 "${BRIDGE_DIR}/logs"
if [[ -f "$BRIDGE_DIR/systemd/mt5-bridge.logrotate" ]]; then
  sed -e "s|__BRIDGE_DIR__|${BRIDGE_DIR}|g" -e "s|__USER__|${BRIDGE_USER}|g" \
    "$BRIDGE_DIR/systemd/mt5-bridge.logrotate" > /etc/logrotate.d/mt5-bridge
  ok "log rotation installed (/etc/logrotate.d/mt5-bridge, 14 days, 10MB)"
fi
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