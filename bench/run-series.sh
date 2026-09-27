#!/usr/bin/env bash
# run-series.sh <arm: bridge|cic> <prefix> [N=5] [START=1]
# N round di run-bench.sh per un arm, task alternati per round (dispari
# form→heavy, pari heavy→form). Prima di ogni run aspetta load1 < 6 e nessun
# `remotion render`; ogni run gira con nice 10.
# Arm cic: prima del giro verifica che Claude in Chrome veda un browser locale
# (list_connected_browsers: un solo browser, locale o con CIC_DEVICE_ID) e si
# ferma dopo una run agganciata a un browser diverso o scollegato: senza questo il 17/07 una run ha girato su
# un Chrome macOS che non raggiungeva localhost:8099.
set -uo pipefail
ARM=$1; PREFIX=$2; N=${3:-5}; START=${4:-1}
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR/.."

gate() {
  for _ in $(seq 1 120); do
    local l r
    l=$(cut -d' ' -f1 /proc/loadavg)
    r=$(ps -eo comm=,args= | awk '$1!="bash" && $1!="sh" && /[r]emotion/ && /[r]ender/' | wc -l)
    if awk -v l="$l" 'BEGIN{exit !(l<6)}' && [ "$r" -eq 0 ]; then return 0; fi
    sleep 15
  done
  return 1
}

curl -sf -o /dev/null "http://localhost:8099/form.html" || {
  echo "server pagine assente: python3 -m http.server 8099 --bind 127.0.0.1 -d bench"; exit 2; }

# Browser ammesso per l'arm cic: un solo browser collegato, locale oppure con
# questo deviceId. Su ChromeOS Claude Code gira nel container Crostini e Chrome
# sull'host: list_connected_browsers risponde isLocal:false anche per il
# Chrome della stessa macchina (verificato il 27/09/2026 aprendo una scheda da
# Claude in Chrome e ritrovandola nella lista di chrome-bridge).
CIC_DEVICE_ID="${CIC_DEVICE_ID:-}"

check_browsers() {  # $1 = stream-json; exit 1 se il browser non è quello ammesso
  python3 - "$1" "$CIC_DEVICE_ID" "$2" <<'PY_EOF'
import json, sys
path, allowed, mode = sys.argv[1], sys.argv[2], sys.argv[3]
lists, disconnected = [], False
for line in open(path):
    try:
        ev = json.loads(line)
    except ValueError:
        continue
    for c in (ev.get("message") or {}).get("content") or []:
        if not (isinstance(c, dict) and c.get("type") == "tool_result"):
            continue
        body = c.get("content")
        text = body if isinstance(body, str) else "".join(x.get("text", "") for x in body or [] if isinstance(x, dict))
        if "extension is not connected" in text:
            disconnected = True
        try:
            v = json.loads(text)
        except ValueError:
            continue
        if isinstance(v, list) and all(isinstance(b, dict) and "deviceId" in b for b in v):
            lists.append(v)
ok = lambda b: b.get("isLocal") is True or (allowed and b.get("deviceId") == allowed)
if disconnected:
    print("STOP: Claude in Chrome non collegato"); sys.exit(1)
if mode == "probe":
    if not lists:
        print("STOP: la sonda non ha restituito list_connected_browsers"); sys.exit(1)
    print("list_connected_browsers:", json.dumps(lists[-1]))
for v in lists:
    if len(v) != 1 or not ok(v[0]):
        print(f"STOP: browser non ammesso {json.dumps(v)} (CIC_DEVICE_ID={allowed or 'non impostato'})"); sys.exit(1)
PY_EOF
}

if [ "$ARM" = cic ]; then
  PROBE="$DIR/results/cic-probe-$PREFIX.stream.jsonl"
  timeout 150 claude --chrome -p "Step 1: ToolSearch select:mcp__claude-in-chrome__list_connected_browsers. Step 2: call mcp__claude-in-chrome__list_connected_browsers with no arguments. Then reply DONE." \
    --model claude-haiku-4-5-20251001 --output-format stream-json --verbose \
    --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
    --allowedTools "mcp__claude-in-chrome__list_connected_browsers,ToolSearch" \
    --permission-mode bypassPermissions > "$PROBE" 2>/dev/null
  check_browsers "$PROBE" probe || exit 4
fi

for i in $(seq "$START" "$N"); do
  if [ $((i % 2)) -eq 1 ]; then ORDER="form heavy"; else ORDER="heavy form"; fi
  for task in $ORDER; do
    gate || { echo "carico o render oltre soglia per 30 minuti: giro interrotto"; exit 3; }
    echo "== $(date +%H:%M:%S) $ARM $task $PREFIX-$i load=$(cut -d' ' -f1 /proc/loadavg)"
    nice -n 10 bash "$DIR/run-bench.sh" "$ARM" "$task" "$PREFIX-$i"
    S="$DIR/results/$ARM-$task-$PREFIX-$i.stream.jsonl"
    if [ "$ARM" = cic ] && ! check_browsers "$S" run; then
      echo "STOP dopo $S"; exit 4
    fi
  done
done
echo "== fine $(date +%H:%M:%S)"
