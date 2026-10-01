#!/usr/bin/env bash
# Ripresa di setup-w128a.sh dopo il build fallito: dist/ non esisteva.
set -euo pipefail
B=/d/workspaces/personali/cb-bench
cd "$B/v128a"
(cd bench/debug && mkdir -p dist && node build.mjs && ls dist)
# claude e node sono nativi: REPO deve essere D:/..., non /d/...
sed -i '/^REPO=/s/pwd)"$/pwd -W)"/' bench/run-bench-v2.sh
grep -n '^REPO=' bench/run-bench-v2.sh
git status --short
mkdir -p "$B/bin" "$B/cc287"
printf '#!/usr/bin/env bash\nexec python "$@"\n' > "$B/bin/python3"
chmod +x "$B/bin/python3"
npm i --prefix "$B/cc287" @anthropic-ai/claude-code@2.1.287 --no-audit --no-fund 2>&1 | tail -1
"$B/cc287/node_modules/.bin/claude" --version
