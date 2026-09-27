#!/usr/bin/env python3
"""Toglie da uno stream-json ciò che descrive l'ambiente di chi lo ha girato e
non serve alla misura: output degli hook di sessione, rate limit dell'account
e, dall'evento init, plugin, skill, cwd e percorsi di memoria. Restano
modello, versione di claude, tool e server MCP. Il deviceId dei browser
collegati a Claude in Chrome diventa "<redacted>". I risultati finiscono in un
repo pubblico.

Uso: python3 sanitize-stream.py FILE.stream.jsonl [...]   (riscrive sul posto)
"""
import json
import re
import sys

DROP_SYSTEM = {"hook_started", "hook_response", "hook_progress"}
# Anche dentro un tool_result, dove il JSON è una stringa con le virgolette escapate.
DEVICE_ID = re.compile(r'(\\?"deviceId\\?"\s*:\s*\\?")[0-9a-fA-F-]{8,}')
KEEP_INIT = ("type", "subtype", "model", "claude_code_version", "tools", "permissionMode")

for path in sys.argv[1:]:
    out = []
    for line in open(path):
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "rate_limit_event":
            continue
        if ev.get("type") == "system" and ev.get("subtype") in DROP_SYSTEM:
            continue
        if ev.get("type") == "system" and ev.get("subtype") == "init":
            slim = {k: ev[k] for k in KEEP_INIT if k in ev}
            slim["mcp_servers"] = [{"name": s.get("name"), "status": s.get("status")} for s in ev.get("mcp_servers") or []]
            ev = slim
        out.append(DEVICE_ID.sub(r"\1<redacted>", json.dumps(ev, ensure_ascii=False)))
    with open(path, "w") as f:
        f.write("\n".join(out) + ("\n" if out else ""))
