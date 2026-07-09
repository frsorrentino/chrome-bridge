# Privacy Policy — Chrome Bridge for Claude Code

_Last updated: July 9, 2026_

## Summary

Chrome Bridge does not collect, store, transmit, sell, or share any user data. Everything stays on your machine.

## What the extension does

Chrome Bridge for Claude Code is a browser automation bridge. It executes commands (navigate, click, read the DOM, take screenshots, etc.) that **you** issue through the Claude Code CLI running on your own computer. Commands and results travel exclusively over a WebSocket connection to `localhost` (default port 8765) — a process on your own machine. The extension never communicates with any remote server.

## Data collection

- **No data is collected.** The extension has no analytics, no telemetry, no crash reporting, no tracking of any kind.
- **No data leaves your machine.** The only network endpoint the extension talks to is `ws://localhost:<port>` on your own computer.
- **No accounts.** The extension requires no sign-up, login, or personal information.

## Why the extension requests broad permissions

The extension asks for permissions such as `cookies`, `webRequest`, `clipboardRead`, `downloads`, and access to all websites (`<all_urls>`). These are required so that the automation commands you issue can operate on whatever page you point them at — for example reading a page's cookies to debug a login flow, mocking network requests, or taking a screenshot. The permissions are used **only** to execute your own commands, on your own browser, at your own request. The extension performs no background activity on its own.

## Arbitrary code execution

The `execute_js` tool runs JavaScript that you author via the `chrome.userScripts` API, which requires you to explicitly enable the "Allow user scripts" toggle in Chrome. This code originates from your own Claude Code session on your machine and is never fetched from a remote source.

## Changes

Any change to this policy will be published at this address and versioned in the [GitHub repository](https://github.com/frsorrentino/chrome-bridge).

## Contact

Questions: open an issue at <https://github.com/frsorrentino/chrome-bridge/issues>.
