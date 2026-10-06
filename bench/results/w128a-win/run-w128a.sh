#!/usr/bin/env bash
# Serie appaiata bridge/bridgeall su win: Edge 154 headless, Claude Code 2.1.287 in cc287.
# uso: [ARMS="bridge bridgeall"] [TASKS="form heavy debug"] run-w128a.sh <prefisso> [N] [START]
set -uo pipefail
B=/d/workspaces/personali/cb-bench
# Python su Windows apre i file in cp1252: lo stream è UTF-8.
export PYTHONUTF8=1
export PATH="$B/bin:$B/cc287/node_modules/.bin:$PATH"
cd "$B/v128a"
PFX=$1; N=${2:-5}; START=${3:-1}
python -m http.server 8099 --bind 127.0.0.1 -d bench >/dev/null 2>&1 &
HTTP=$!
trap 'kill $HTTP 2>/dev/null' EXIT
for _ in $(seq 1 15); do curl -sf -o /dev/null http://localhost:8099/form.html && break; sleep 1; done
echo "claude $(claude --version) · python3 $(python3 --version) · REPO $(grep -c 'pwd -W' bench/run-bench-v2.sh)"
for ARM in ${ARMS:-bridge bridgeall}; do
  CHROME_BRIDGE_CAPS=core TASKS="${TASKS:-form heavy debug}" bash bench/run-series-v2.sh "$ARM" "$PFX" "$N" "$START"
done
python3 bench/aggregate.py "bridge:$PFX" "bridgeall:$PFX"
