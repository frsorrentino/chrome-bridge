#!/usr/bin/env bash
# Serie appaiata su win con i bracci alternati run per run (ordine invertito nei giri pari):
# Edge 154 headless, Claude Code 2.1.287 in cc287, claude in una cartella vuota (run-bench-v2.sh da afd7a15).
# uso: [ARMS="bridge bridgeall"] [TASKS="form heavy debug"] run-w128b.sh <prefisso> [N]
set -uo pipefail
B=/d/workspaces/personali/cb-bench
# Python su Windows apre i file in cp1252: lo stream è UTF-8.
export PYTHONUTF8=1
export PATH="$B/bin:$B/cc287/node_modules/.bin:$PATH"
cd "$B/v128b"
PFX=$1; N=${2:-5}
python -m http.server 8099 --bind 127.0.0.1 -d bench >/dev/null 2>&1 &
HTTP=$!
trap 'kill $HTTP 2>/dev/null' EXIT
for _ in $(seq 1 15); do curl -sf -o /dev/null http://localhost:8099/form.html && break; sleep 1; done
echo "claude $(claude --version) · REPO $(grep -c 'pwd -W' bench/run-bench-v2.sh) · HEAD $(git rev-parse --short HEAD)"
for i in $(seq 1 "$N"); do
  ORDER="${ARMS:-bridge bridgeall}"
  [ $((i % 2)) -eq 0 ] && ORDER=$(echo "$ORDER" | awk '{for (k = NF; k > 0; k--) printf "%s%s", $k, (k > 1 ? " " : "")}')
  for task in ${TASKS:-form heavy debug}; do
    for arm in $ORDER; do
      CHROME_BRIDGE_CAPS=core TASKS="$task" bash bench/run-series-v2.sh "$arm" "$PFX" "$i" "$i"
    done
  done
done
python3 bench/aggregate.py "bridge:$PFX" "bridgeall:$PFX"
