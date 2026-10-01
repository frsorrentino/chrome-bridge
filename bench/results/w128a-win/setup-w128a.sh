#!/usr/bin/env bash
# Prepara su win la copia di chrome-bridge ee55202 per la serie appaiata w128a.
set -euo pipefail
B=/d/workspaces/personali/cb-bench
cd "$B"
[ -e v128a ] && { echo "v128a esiste già: mi fermo"; exit 1; }
# Clone locale del repo già presente + bundle dei commit mancanti; autocrlf
# spento, altrimenti gli .sh escono in CRLF e bash li rifiuta.
git clone -q --no-checkout -c core.autocrlf=false /d/workspaces/personali/chrome-bridge v128a
cd v128a
git fetch -q "$B/cb-v128a.bundle" "+refs/heads/main:refs/remotes/bundle/main"
git checkout -q --detach ee55202
git log --oneline -1
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -1
(cd bench/debug && node build.mjs && ls dist)
# claude e node sono nativi: REPO deve essere D:/..., non /d/...
sed -i '/^REPO=/s/pwd)"$/pwd -W)"/' bench/run-bench-v2.sh
grep -n '^REPO=' bench/run-bench-v2.sh
git status --short
mkdir -p "$B/bin" "$B/cc287"
printf '#!/usr/bin/env bash\nexec python "$@"\n' > "$B/bin/python3"
chmod +x "$B/bin/python3"
npm i --prefix "$B/cc287" @anthropic-ai/claude-code@2.1.287 --no-audit --no-fund 2>&1 | tail -1
"$B/cc287/node_modules/.bin/claude" --version
