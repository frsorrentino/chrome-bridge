# Chrome Web Store listing — Chrome Bridge for Claude Code

## Name

Chrome Bridge for Claude Code

## Summary (max 132 chars)

Bridge your browser to Claude Code: 56 web-dev automation tools over a local WebSocket. Cross-platform, ChromeOS included.

## Category

Developer Tools

## Language

English

## Single purpose statement

This extension has a single purpose: it lets the user's own Claude Code CLI (running locally on their machine) inspect and drive the user's browser for web development and testing. It executes only commands the user issues, received exclusively over a WebSocket connection to localhost, and performs no autonomous background activity.

## Detailed description

Chrome Bridge connects Claude Code — Anthropic's CLI coding agent — to your real, logged-in Chrome browser. No headless instance, no debugging port, no cloud service: a local WebSocket (localhost:8765) bridges the Claude Code MCP server on your machine to this extension.

56 specialized web-development tools:

• Navigation & tabs — open, close, navigate, list tabs
• DOM — query selectors (shadow-DOM piercing), read pages as markdown, list interactive elements, modify the DOM
• Input — click, type, press keys, fill forms, drag & drop, upload files
• Screenshots — viewport, element, full page, visual regression diff; captures run in the background without stealing window focus
• Audits — accessibility (WCAG), SEO, security headers, web vitals, unused CSS
• Network — monitor requests, mock/block/redirect, WebSocket monitoring, HAR export
• Debugging — console logs, JS execution, event listeners, performance metrics
• Emulation — media, geolocation, viewport, zoom

Cross-platform: Windows, macOS, Linux — any desktop Chrome 135+. Also the only Claude Code browser automation that works on ChromeOS (Crostini).

REQUIREMENTS

This extension is a companion to the open-source chrome-bridge MCP server and requires it to be installed and configured with Claude Code:
https://github.com/frsorrentino/chrome-bridge

The execute_js tool additionally requires enabling the "Allow user scripts" toggle in the extension's details page (chrome://extensions).

PRIVACY

Everything stays on your machine. The extension talks only to localhost — no remote servers, no analytics, no data collection. Privacy policy: https://frsorrentino.github.io/chrome-bridge/privacy

## URLs for the form

- Homepage: https://github.com/frsorrentino/chrome-bridge
- Support: https://github.com/frsorrentino/chrome-bridge/issues
- Privacy policy: https://frsorrentino.github.io/chrome-bridge/privacy

## Data usage disclosures (Privacy tab of the CWS form)

- "Does your extension collect or use any of the following user data?" → check NOTHING (no data collected).
- Certify: data is not sold, not used for unrelated purposes, not used for creditworthiness.
