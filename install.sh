#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_ENTRY="$SCRIPT_DIR/server/index.js"

echo "=== Chrome Bridge Installer ==="
echo ""

# 1. Check Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required but not installed."
  echo "Install it from https://nodejs.org/ or via your package manager."
  exit 1
fi
echo "[OK] Node.js $(node -v)"

# 2. Install npm dependencies
echo ""
echo "Installing dependencies..."
cd "$SCRIPT_DIR"
npm install --silent
echo "[OK] Dependencies installed"

# 3. Register MCP server in Claude Code
echo ""
if command -v claude &>/dev/null; then
  echo "Registering MCP server in Claude Code..."
  # -e CHROME_BRIDGE_CAPS=all: senza questo il default e caps=core (30 tool su 59)
  # e chi installa non ha extract_table/audits, che i doc promettono.
  claude mcp add --scope user chrome-bridge -e CHROME_BRIDGE_CAPS=all -- node "$SERVER_ENTRY" 2>/dev/null && \
    echo "[OK] MCP server registered (scope: user, all 59 tools)" || \
    echo "[SKIP] MCP server already registered or claude command failed"
else
  echo "[SKIP] 'claude' CLI not found. Register manually:"
  echo "  claude mcp add --scope user chrome-bridge node $SERVER_ENTRY"
fi

# 4. Preflight: porta e piattaforma
echo ""
if command -v ss &>/dev/null && ss -ltn 2>/dev/null | grep -q ':8765 '; then
  echo "[NOTE] Port 8765 is already in use — a second chrome-bridge starts as a relay"
  echo "       and shares the existing bridge. Set CHROME_BRIDGE_PORT to change it."
fi

# 5. Chrome extension instructions
echo ""
echo "=== Chrome Extension Setup ==="
echo ""
if [ "$(hostname)" = "penguin" ]; then
  # Su ChromeOS/Crostini un'estensione caricata da filesystem viene scartata a
  # ogni reboot: il container non e montato quando Chrome parte.
  echo "  ChromeOS/Crostini detected — install from the Chrome Web Store instead"
  echo "  of Load unpacked (a filesystem-loaded extension is dropped on reboot):"
  echo "  https://chromewebstore.google.com/detail/chrome-bridge-for-claude/bioknpaeahidbelaljjohjofiloeodmb"
else
  echo "  1. Open chrome://extensions in Chrome"
  echo "  2. Enable 'Developer mode' (top right toggle)"
  echo "  3. Click 'Load unpacked'"
  echo "  4. Select: $SCRIPT_DIR/extension"
fi
echo ""
echo "  Then enable 'Allow user scripts' in the extension Details page"
echo "  (needed by execute_js and wait_for(condition=function))."
echo ""
echo "=== Done ==="
echo ""
echo "After loading the extension, restart Claude Code."
echo "The extension popup shows connection status."
echo "Test with: node $SCRIPT_DIR/test/test-devtools.js"
