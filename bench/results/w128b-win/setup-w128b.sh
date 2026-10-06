#!/usr/bin/env bash
# Prepara su win la copia di chrome-bridge afd7a15 (bench fuori dal repo) per la serie w128b.
set -euo pipefail
B=/d/workspaces/personali/cb-bench
cd "$B"
[ -e v128b ] && { echo "v128b esiste già: mi fermo"; exit 1; }
git clone -q --no-checkout -c core.autocrlf=false /d/workspaces/personali/chrome-bridge v128b
cd v128b
git fetch -q "$B/cb-v128b.bundle" "+refs/heads/main:refs/remotes/bundle/main"
git checkout -q --detach afd7a15
git log --oneline -1
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -1
(cd bench/debug && mkdir -p dist && node build.mjs >/dev/null && ls dist | tr '\n' ' ')
echo
# claude e node sono nativi: REPO deve essere D:/..., non /d/...
sed -i '/^REPO=/s/pwd)"$/pwd -W)"/' bench/run-bench-v2.sh
grep -n '^REPO=' bench/run-bench-v2.sh
grep -c 'EAGER\|extract_table' server/tools.js
