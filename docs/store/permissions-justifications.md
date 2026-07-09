# Permission justifications — CWS form (Privacy practices tab)

One paragraph per permission, ready to paste.

## tabs

Required to list open tabs (get_tabs tool), create/close/activate tabs, and resolve which tab an automation command targets. Core to every browser automation command the user issues.

## scripting

Required to inject the static, extension-bundled functions that implement DOM tools (query selectors, read page content, click, fill forms, take element measurements) into the page the user is automating.

## userScripts

Required by the execute_js and wait_for tools, which run JavaScript snippets authored by the user in their own Claude Code session. The userScripts API is used precisely as intended: executing user-authored scripts, gated behind Chrome's "Allow user scripts" toggle which the user must enable explicitly.

## alarms

Keeps the extension's service worker alive and schedules WebSocket reconnection attempts to the local bridge server. No user data involved.

## storage

Stores the extension's own settings locally: WebSocket port, optional authentication token, and the page-instrumentation on/off preference. Also used by the get_storage/set_storage debugging tools to read/write localStorage of the page under automation, at the user's request.

## cookies

Powers the get_storage/set_storage tools' cookie mode, letting the user inspect and set cookies of the site they are debugging (e.g. reproducing a login state). Only runs when the user issues the command; cookies are returned to the user's own local CLI and nowhere else.

## webNavigation

Detects page load and SPA route-change completion so navigation tools can report when a page is ready, and tracks frames for iframe-targeted commands.

## webRequest

Powers the network monitoring tools (monitor_network, HAR export, WebSocket monitoring): the user watches their own page's requests for debugging. Data is reported only to the user's local CLI.

## webRequestAuthProvider

Lets the http_auth tool answer HTTP Basic/Digest authentication challenges with credentials the user supplies, so automation can reach password-protected staging sites.

## declarativeNetRequest

Powers the network_rules tool: the user can block, redirect, or modify headers of requests on the page under test (e.g. mocking an API during development).

## clipboardRead / clipboardWrite

Power the clipboard tool, which lets the user read/write the clipboard as part of automation flows (e.g. verifying a "copy to clipboard" button works).

## downloads

Powers the manage_downloads tool (list, wait for completion) and save_page, so automation can verify file-download flows.

## pageCapture

Powers the save_page tool, which captures the current page as MHTML to the user's own disk for offline inspection.

## Host permission: <all_urls>

The extension is a general-purpose web-development automation bridge: the user points it at whatever site they are developing or testing (localhost apps, staging servers, production sites). The target is unknowable in advance, so access to all URLs is required. The extension acts only on explicit user commands received from localhost and performs no autonomous browsing.

## Remote code

No remote code. All executable code ships in the extension package. The execute_js tool runs user-authored snippets via the chrome.userScripts API (see userScripts justification); nothing is fetched from remote servers.
