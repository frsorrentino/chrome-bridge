# Chrome Bridge for Claude

Borrow a tab from the Chrome you already use, signed in with your own accounts,
and hand it back. Claude Code can navigate, read pages, fill forms, inspect the
DOM, compare screenshots, audit a page and record a flow in that browser. Logins,
two-factor codes and CAPTCHAs stay with you: the `handoff` tool shows a banner in
the page and waits until you have done your part. Works on ChromeOS too.

## What this plugin contains

- `dist/`: the MCP server and the `chrome-bridge` command line tool, bundled from
  the `server/` folder of the repository (readable, not minified; licenses in
  `dist/THIRD_PARTY_LICENSES.md`). Claude Code starts it with `node`.
- `skills/chrome-bridge/`: recipes for longer browser tasks (a form until the
  email arrives, a checkout with a test card, redirects after a migration…).
- `commands/observe.md` and `hooks/`: `/chrome-bridge:observe`, which keeps a
  local note of the tool errors so you can send them to the maintainer only if
  you choose to.

## Setup

1. Install the Chrome extension «Chrome Bridge for Claude» from the
   [Chrome Web Store](https://chromewebstore.google.com/detail/chrome-bridge-for-claude/bioknpaeahidbelaljjohjofiloeodmb).
   The server talks to it over a WebSocket on `127.0.0.1` by default.
2. Start a Claude Code session and ask for something in the browser, for
   example «open example.com and read the title».

Source, documentation and the full list of tools:
https://github.com/frsorrentino/chrome-bridge. Privacy policy:
https://frsorrentino.github.io/chrome-bridge/privacy. License: MIT.
