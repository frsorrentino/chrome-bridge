#!/usr/bin/env bash
# py.sh script.py args… — runs a Python script with the first real Python 3.8+: python3, python, py -3.
# On Windows `python3` is often the Microsoft Store alias: it exists (command -v succeeds) but exits 9009 (49 in Git
# Bash), so every candidate is run, never just looked up. PYTHONUTF8: Windows Python otherwise reads and writes cp1252.
# With no Python at all: one line on stderr and exit 0, so a hook never fails the session. The choice is cached
# (CLAUDE_OBSERVE_PY overrides it): hooks run every turn, and on Windows probing the Store alias alone costs ~0.2 s.
cache="${XDG_CACHE_HOME:-$HOME/.cache}/claude-observe/python"
py="${CLAUDE_OBSERVE_PY:-}"
if [ -z "$py" ] && [ -r "$cache" ]; then
  read -r py < "$cache" || py=""
  command -v "${py%% *}" >/dev/null 2>&1 || py=""   # uninstalled since: probe again
fi
if [ -z "$py" ]; then
  for c in python3 python "py -3"; do
    if $c -c 'import sys; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; then
      py=$c
      { mkdir -p "${cache%/*}" && printf '%s\n' "$py" > "$cache"; } 2>/dev/null
      break
    fi
  done
fi
if [ -z "$py" ]; then
  echo "claude-observe: no Python 3.8+ found (python3, python, py -3): install Python 3 to record this plugin's errors" >&2
  exit 0
fi
export PYTHONUTF8=1 PYTHONIOENCODING=utf-8
exec $py "$@"
