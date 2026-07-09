# Support — Chrome Bridge for Claude Code

## Report a bug / request a feature

Open an issue on the GitHub repository:
**<https://github.com/frsorrentino/chrome-bridge/issues>**

Please include:
- Chrome version and operating system
- Extension version (visible in `chrome://extensions`)
- What command/tool you ran and the error message

## Documentation

- [README — setup, tool reference, troubleshooting](https://github.com/frsorrentino/chrome-bridge#readme)
- [Privacy policy](./privacy)

## Common issues

**`execute_js` / `wait_for` return "User scripts are disabled"** — open `chrome://extensions`, click *Details* on Chrome Bridge and enable **Allow user scripts** (on Chrome 135-137 enable Developer Mode instead).

**Extension shows "Disconnected"** — the companion MCP server is not running. Check your Claude Code MCP configuration; the extension connects to `ws://localhost:8765`.

**Screenshot commands fail with "window is not rendering frames"** — the Chrome window is fully hidden or minimized. Bring it at least partially on screen and retry.
