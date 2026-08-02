#!/usr/bin/env bash
# One-command installer entrypoint for the MT5 Bridge (Ubuntu).
#   curl -fsSL <raw-url>/install.sh | sudo bash
#   or: sudo bash install.sh
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bridge/scripts/install.sh" "$@"