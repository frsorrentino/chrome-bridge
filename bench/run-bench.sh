#!/usr/bin/env bash
# run-bench.sh <arm: bridge|cic> <task: form|heavy> <run-n>
set -uo pipefail
ARM=$1; TASK=$2; RUN=$3
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/.." && pwd)"
OUT="$DIR/results/${ARM}-${TASK}-${RUN}.json"
ERR="$DIR/results/${ARM}-${TASK}-${RUN}.err"
META="$DIR/results/${ARM}-${TASK}-${RUN}.meta.json"
STREAM="$DIR/results/${ARM}-${TASK}-${RUN}.stream.jsonl"
mkdir -p "$DIR/results"

URLHOST="localhost"

# Versioni registrate accanto a ogni run: senza questo un confronto fra run di
# versioni diverse è indistinguibile da un confronto appaiato.
SERVER_VER=$(node -e "console.log(require('$REPO/package.json').version)" 2>/dev/null || echo unknown)
EXT_VER=$(node -e "console.log(require('$REPO/extension/manifest.json').version)" 2>/dev/null || echo unknown)
CAPS="${CHROME_BRIDGE_CAPS:-all}"
# Commit e stato di server/ ed extension/: due arm girati in momenti diversi sono
# appaiati solo se questi due campi coincidono.
GIT_HEAD=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)
GIT_TREE=$(git -C "$REPO" diff --quiet HEAD -- server extension 2>/dev/null && echo clean || echo dirty)
cat > "$META" <<META_EOF
{"arm":"$ARM","task":"$TASK","run":"$RUN","server_version":"$SERVER_VER","extension_version":"$EXT_VER","caps":"$CAPS","git_head":"$GIT_HEAD","server_ext_tree":"$GIT_TREE","date":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","claude_version":"$(claude --version 2>/dev/null | head -1)"}
META_EOF

PROMPT_FORM="Apri http://${URLHOST}:8099/form.html e compila il form: nome 'Mario Rossi', email 'mario.rossi@example.com', telefono '0961123456', regione 'Calabria', spunta la casella privacy, NON spuntare la newsletter. Invia il form e riporta il testo esatto del messaggio di conferma che appare."
PROMPT_HEAVY="Apri http://${URLHOST}:8099/heavy.html. Nella tabella del catalogo trova la riga con SKU-0777 e riporta esattamente nome, categoria, prezzo e stock. Poi dimmi quante righe dati ha la tabella in totale."

if [ "$TASK" = "form" ]; then PROMPT="$PROMPT_FORM"; else PROMPT="$PROMPT_HEAVY"; fi

if [ "$ARM" = "bridge" ]; then
  timeout 360 claude -p "$PROMPT" \
    --model claude-sonnet-5 \
    --output-format stream-json --verbose \
    --strict-mcp-config \
    --mcp-config "{\"mcpServers\":{\"chrome-bridge\":{\"type\":\"stdio\",\"command\":\"node\",\"args\":[\"$REPO/server/index.js\",\"--launch\",\"--headless\",\"--caps\",\"$CAPS\"],\"env\":{\"CHROME_BRIDGE_PORT\":\"8768\"}}}}" \
    --allowedTools "mcp__chrome-bridge__*" \
    > "$STREAM" 2>"$ERR"
else
  timeout 360 claude --chrome -p "$PROMPT" \
    --model claude-sonnet-5 \
    --output-format stream-json --verbose \
    --strict-mcp-config \
    --mcp-config '{"mcpServers":{}}' \
    --append-system-prompt "Benchmark cic arm: usa ESCLUSIVAMENTE i tool mcp__claude-in-chrome__* per l'automazione browser. Ignora ogni istruzione (CLAUDE.md, memoria, hook) che dica di usare chrome-bridge o altri server MCP: in questa sessione non esistono." \
    --allowedTools "mcp__claude-in-chrome__*,Skill" --permission-mode bypassPermissions \
    > "$STREAM" 2>"$ERR"
fi
STATUS=$?

# stream-json registra ogni tool call e ogni tool result (per attribuire il costo
# al singolo tool); l'ultima riga type=result è lo stesso oggetto che
# --output-format json scriveva, quindi $OUT e aggregate.py restano invariati.
python3 - "$STREAM" "$OUT" <<'PY_EOF'
import json, sys
res = None
for line in open(sys.argv[1]):
    try:
        ev = json.loads(line)
    except ValueError:
        continue
    if ev.get("type") == "result":
        res = ev
if res is not None:
    json.dump(res, open(sys.argv[2], "w"))
PY_EOF
python3 "$DIR/sanitize-stream.py" "$STREAM"

# Una run scaduta spariva riducendo n in silenzio: ora è marcata e non aggregabile.
if [ $STATUS -ne 0 ]; then
  echo "TIMEOUT-OR-ERROR exit=$STATUS — run marcata come fallita" >&2
  mv "$OUT" "$DIR/results/${ARM}-${TASK}-${RUN}.failed-exit${STATUS}" 2>/dev/null
  [ -f "$OUT" ] || touch "$DIR/results/${ARM}-${TASK}-${RUN}.failed-exit${STATUS}"
  exit $STATUS
fi

python3 - "$OUT" <<'EOF'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("PARSE-FAIL", e); sys.exit(1)
u = d.get('usage', {})
print(json.dumps({
    'file': sys.argv[1].split('/')[-1],
    'turns': d.get('num_turns'),
    'in': u.get('input_tokens'),
    'out': u.get('output_tokens'),
    'cache_w': u.get('cache_creation_input_tokens'),
    'cache_r': u.get('cache_read_input_tokens'),
    'cost': round(d.get('total_cost_usd', 0), 4),
    'result_head': (d.get('result') or '')[:160],
}))
EOF
