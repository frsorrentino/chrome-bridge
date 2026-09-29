#!/usr/bin/env python3
"""Aggrega i risultati in bench/results/ per arm+task: mediana e min-max di
turni/token/costo, rapporti cic/bridge sulle mediane e, dove esiste lo
.stream.jsonl, chiamate e byte restituiti per singolo tool.

Uso: python3 aggregate.py [pattern-run]              # es. "0927-": stesso prefisso per tutti gli arm
     python3 aggregate.py bridge:0927v1232 cic:0927-   # prefisso per arm (set appaiato del 27/09)
"""
import json
import sys
from glob import glob
from os.path import basename, dirname, join
from statistics import mean, median

# Risposta attesa per task: una run veloce ma sbagliata non è un successo.
# Contata e stampata, non esclusa (regola di inclusione).
EXPECT = {
    "form": ["Registrazione completata", "Mario Rossi", "mario.rossi@example.com", "Calabria", "newsletter: no"],
    "heavy": ["Prodotto 777", "Casa", "292", "1500"],
    # Dal 29/09: pagina di checkout rotta (bench/debug). Tre cause da trovare.
    "debug": ["cart.js:10", "404", "brand-primary"],
}

run_filter, arm_filter = "", {}
for a in sys.argv[1:]:
    if ":" in a:
        k, v = a.split(":", 1)
        arm_filter[k] = v
    else:
        run_filter = a
cells = {}
skipped = []
for f in sorted(glob(join(dirname(__file__) or ".", "results", "*.json"))):
    if f.endswith(".meta.json"):
        continue
    arm, task, run = basename(f)[:-5].split("-", 2)
    if arm_filter:
        if arm not in arm_filter or not run.startswith(arm_filter[arm]):
            continue
    elif run_filter and not run.startswith(run_filter):
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
        "stream": f[:-5] + ".stream.jsonl",
        "ok": all(x in (d.get("result") or "").replace("1.500", "1500") for x in EXPECT.get(task, [])),
    })

def rng(vals):
    lo, hi = min(vals), max(vals)
    return f"{lo:g}-{hi:g}" if lo != hi else f"{lo:g}"


def med(rows, k):
    return median(r[k] for r in rows)


for (arm, task), rows in sorted(cells.items(), key=lambda kv: (kv[0][1], kv[0][0])):
    n = len(rows)
    col = lambda k: [r[k] for r in rows]
    # Mediana + min-max, non la sola media: con n piccolo la media nasconde
    # una varianza che nei nostri dati arriva a 7,4x.
    print(f"{task:6s} {arm:7s} n={n} ok={sum(r['ok'] for r in rows)}/{n}  turni med={med(rows, 'turns'):5.1f} [{rng(col('turns'))}]  "
          f"out med={med(rows, 'out'):6.0f} [{rng(col('out'))}]  "
          f"cache_r med={med(rows, 'cache_r')/1000:4.0f}k [{min(col('cache_r'))/1000:.0f}-{max(col('cache_r'))/1000:.0f}k]  "
          f"$ med={med(rows, 'cost'):.3f} [{min(col('cost')):.3f}-{max(col('cost')):.3f}]   "
          f"runs: {','.join(r['run'] for r in rows)}")

# Rapporti cic/bridge sulle mediane: >1 = chrome-bridge ne usa meno
print()
for task in sorted({t for _, t in cells}):
    b, c = cells.get(("bridge", task)), cells.get(("cic", task))
    if not (b and c):
        continue
    ratio = lambda k: med(c, k) / med(b, k) if med(b, k) else float("nan")
    print(f"{task:6s} cic/bridge  turni {ratio('turns'):.2f}x  out {ratio('out'):.2f}x  "
          f"cache_r {ratio('cache_r'):.2f}x  costo {ratio('cost'):.2f}x  (n bridge={len(b)}, cic={len(c)})")

# Costo per tool: chiamate, errori e byte del tool_result che entrano nel
# contesto (e da lì in cache read a ogni turno successivo). Serve stream-json.
print()
for (arm, task), rows in sorted(cells.items(), key=lambda kv: (kv[0][1], kv[0][0])):
    per, runs = {}, 0
    for r in rows:
        try:
            lines = open(r["stream"]).read().splitlines()
        except OSError:
            continue
        runs += 1
        names = {}
        for line in lines:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            msg = ev.get("message")
            content = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(content, list):
                continue
            for c in content:
                if c.get("type") == "tool_use":
                    names[c["id"]] = c["name"].replace("mcp__claude-in-chrome__", "").replace("mcp__chrome-bridge__", "")
                elif c.get("type") == "tool_result":
                    t = per.setdefault(names.get(c.get("tool_use_id"), "?"), [0, 0, 0, 0])
                    t[0] += 1
                    t[1] += bool(c.get("is_error"))
                    body = c.get("content")
                    if isinstance(body, list):
                        # Le immagini si contano a parte: il modello le paga a
                        # pixel (~larghezza×altezza/750 token), non a byte di base64.
                        t[2] += sum(len(x.get("text") or "") for x in body if isinstance(x, dict))
                        t[3] += sum(1 for x in body if isinstance(x, dict) and x.get("type") == "image")
                    else:
                        t[2] += len(body or "")
    if not runs:
        continue
    print(f"{task:6s} {arm:7s} tool su {runs} run (chiamate/run, errori tot, KB di testo/run, immagini/run):")
    for name, (calls, errs, size, imgs) in sorted(per.items(), key=lambda kv: -(kv[1][2] + kv[1][3] * 6000)):
        print(f"    {name:28s} {calls/runs:4.1f}  err={errs:<3d} {size/runs/1000:7.1f} KB"
              + (f"  img={imgs/runs:.1f}" if imgs else ""))

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
    if not b.endswith((".json", ".err", ".stream.jsonl")):
        print(f"NON AGGREGATA {b}: estensione fuori dal glob *.json", file=sys.stderr)
