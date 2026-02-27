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
  claude mcp add --scope user chrome-bridge node "$SERVER_ENTRY" 2>/dev/null && \
    echo "[OK] MCP server registered (scope: user)" || \
    echo "[SKIP] MCP server already registered or claude command failed"
else
  echo "[SKIP] 'claude' CLI not found. Register manually:"
  echo "  claude mcp add --scope user chrome-bridge node $SERVER_ENTRY"
fi

# 4. Chrome extension instructions
echo ""
echo "=== Chrome Extension Setup ==="
echo ""
echo "  1. Open chrome://extensions in Chrome"
echo "  2. Enable 'Developer mode' (top right toggle)"
echo "  3. Click 'Load unpacked'"
echo "  4. Select: $SCRIPT_DIR/extension"
echo ""
echo "=== Done ==="
echo ""
echo "After loading the extension, restart Claude Code."
echo "The extension popup shows connection status."
echo "Test with: node $SCRIPT_DIR/test/test-devtools.js"
