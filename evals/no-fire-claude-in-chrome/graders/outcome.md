---
type: llm
---

PASS if the reply uses or plans to use the Claude in Chrome extension tools (claude-in-chrome), or says plainly that those tools are not available in this session, without switching the user to a different browser tool they did not ask for.
FAIL if the reply substitutes chrome-bridge (its MCP tools, CLI or skill) for the tool the user named, or lectures the user on which extension to use.
