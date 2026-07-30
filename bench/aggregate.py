#!/usr/bin/env python3
"""Aggrega i risultati in bench/results/ per arm+task: media turni/token/costo.

Uso: python3 aggregate.py [pattern-run]   # es. "17" per le sole run 1.7.0
"""
import json
import sys
from glob import glob
from os.path import basename, dirname, join
from statistics import mean, median

run_filter = sys.argv[1] if len(sys.argv) > 1 else ""
cells = {}
skipped = []
for f in sorted(glob(join(dirname(__file__) or ".", "results", "*.json"))):
    arm, task, run = basename(f)[:-5].split("-", 2)
    if run_filter and not run.startswith(run_filter):
        continue
    try:
        d = json.load(open(f))
    except json.JSONDecodeError as e:
        # Uno scarto silenzioso riduce n senza lasciare traccia nel report.
        skipped.append((basename(f), f"JSON non valido: {e}"))
        continue
    if d.get("is_error") or d.get("num_turns") is None:
        skipped.append((basename(f), f"is_error={d.get('is_error')}, num_turns={d.get('num_turns')}"))
        continue
    u = d.get("usage", {})
    cells.setdefault((arm, task), []).append({
        "run": run,
        "turns": d["num_turns"],
        "out": u.get("output_tokens", 0),
        "cache_r": u.get("cache_read_input_tokens", 0),
        "cost": d.get("total_cost_usd", 0),
    })

def rng(vals):
    lo, hi = min(vals), max(vals)
    return f"{lo:g}-{hi:g}" if lo != hi else f"{lo:g}"


for (arm, task), rows in sorted(cells.items(), key=lambda kv: (kv[0][1], kv[0][0])):
    n = len(rows)
    turns = [r["turns"] for r in rows]
    outs = [r["out"] for r in rows]
    # Mediana + min-max, non la sola media: con n piccolo la media nasconde
    # una varianza che nei nostri dati arriva a 7,4x.
    print(f"{task:6s} {arm:7s} n={n}  turni med={median(turns):5.1f} [{rng(turns)}]  "
          f"out med={median(outs):6.0f} [{rng(outs)}]  "
          f"cache_r={mean(r['cache_r'] for r in rows)/1000:6.0f}k  "
          f"$={mean(r['cost'] for r in rows):.3f}   "
          f"runs: {','.join(r['run'] for r in rows)}")

# n diverso fra i due arm dello stesso task = confronto non appaiato
by_task = {}
for (arm, task), rows in cells.items():
    by_task.setdefault(task, {})[arm] = len(rows)
for task, arms in sorted(by_task.items()):
    if len(arms) > 1 and len(set(arms.values())) > 1:
        detail = ", ".join(f"{a}={n}" for a, n in sorted(arms.items()))
        print(f"WARNING {task}: n diverso fra gli arm ({detail}) — confronto NON appaiato, "
              f"non pubblicabile senza dichiararlo", file=sys.stderr)

if skipped:
    print("", file=sys.stderr)
    for name, why in skipped:
        print(f"SCARTATA {name}: {why}", file=sys.stderr)

# File nella dir dei risultati che non finiscono nel glob *.json: invisibili al report
for f in sorted(glob(join(dirname(__file__) or ".", "results", "*"))):
    b = basename(f)
    if not b.endswith((".json", ".err")):
        print(f"NON AGGREGATA {b}: estensione fuori dal glob *.json", file=sys.stderr)
