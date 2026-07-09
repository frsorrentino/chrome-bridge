#!/usr/bin/env bash
# Impacchetta extension/ in uno zip pronto per l'upload sul Chrome Web Store.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$ROOT/extension/manifest.json')).version)")
OUT="$ROOT/dist/chrome-bridge-extension-$VERSION.zip"

mkdir -p "$ROOT/dist"
rm -f "$OUT"

# Zip con manifest.json in root (richiesto da CWS): zippare il contenuto, non la cartella
cd "$ROOT/extension"
zip -r -X "$OUT" . -x "*.DS_Store" -x "*~"

echo "Creato: $OUT"
unzip -l "$OUT"
