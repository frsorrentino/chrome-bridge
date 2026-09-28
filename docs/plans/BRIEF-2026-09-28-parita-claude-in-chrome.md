# Brief: chrome-bridge must truly do everything Claude in Chrome does, plus more (Franz, 28/09/2026 20:58)

Franz: «I'd like us to really have everything Claude in Chrome has, plus more tools and more efficiency.»

Prompted by an honest comparison written by another session. Where Claude in Chrome is ahead:
- it records GIFs and videos;
- it has the `debugger` permission, so its clicks are "real" (trusted): some hand-built dropdowns refuse synthetic clicks and do not open for us;
- it is official and integrated, with automatic approval of actions.

Caution for the film: with its `javascript_tool`, Claude in Chrome can also read and change the DOM, computed CSS and storage. There the difference is turns and cost, not «it can't». «It can't» holds only for what in-page JavaScript cannot do: network simulation, visual diff, header audits, window layout.

## Claude in Chrome's real tools (read from the tool list of the master session, 28/09)

`computer`, `browser_batch`, `find`, `form_input`, `get_page_text`, `gif_creator`, `javascript_tool`, `navigate`, `read_page`, `read_console_messages`, `read_network_requests`, `resize_window`, `tabs_context_mcp` / `tabs_create_mcp` / `tabs_close_mcp`, `file_upload`, `upload_image`, `shortcuts_list` / `shortcuts_execute`, `list_connected_browsers` / `select_browser` / `switch_browser`.

## Task: PLAN ONLY (no code, no release)

Write `docs/plans/2026-09-28-parity-claude-in-chrome.md`. For each capability:
1. **Gap table.** CiC capability → the chrome-bridge equivalent today (existing tool) → state: equal / better / missing / worse. Verify it on the code and, where it costs little, with a real test. Do not rely on memory.
2. **For each gap, the proposed design, its limits and its cost** (S/M/L). At least:
   - **GIF/video recording** of the tab (frames via `captureVisibleTab`, or `tabCapture` + MediaRecorder in an offscreen document; GIF/WebM/MP4 encoding on the server with ffmpeg);
   - **trusted input** via the `chrome.debugger` optional permission (`Input.dispatchMouseEvent` / `dispatchKeyEvent`) as a fallback when the synthetic click has no effect. It shows the «is debugging this browser» bar. **Verify on ChromeOS**: our notes say `chrome.debugger` does not work there; measure it again;
   - **coordinate actions** (click/drag at x,y on a screenshot, as `computer` does) for canvases and non-DOM widgets;
   - **batch**: several actions in one call (like `browser_batch`), to cut turns;
   - **multiple connected browsers** (list / select / switch): for example the Chromebook and the Windows PC. Tie it to claude-master multi-PC;
   - **saved shortcuts / workflows** vs our record/replay;
   - **approving actions**: how a user pre-authorizes chrome-bridge tools in Claude Code (permission rules, a setup command), documented;
   - **`find` in natural language** vs our `get_interactives` / `find_text`.
3. **Where we already go further**, to put in the README and the film: network simulation, screenshot_diff, audits, window layout, handoff, 60 tools, turns and cost (paired benchmark). **Only real claims, with their source.**
4. **Suggested order** (value/cost), which **new permissions** each piece requires in the manifest, the impact on the Chrome Web Store review (for example the `debugger` permission triggers a stricter review and a warning at install), and version numbers.

Constraints:
- Personal weekly quota at 91%, reset Thursday 01/10 04:00: a lean plan, no prototypes unless one costs little and settles a doubt (for example the `debugger` test on ChromeOS).
- Local commits, no push, no release. The plan goes to `master` for Franz.
