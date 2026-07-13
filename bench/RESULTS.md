# chrome-bridge vs claude-in-chrome — benchmark token/turni

Confronto a parità di modello (Claude Sonnet 5) e task tra **chrome-bridge**
(MCP via estensione, DOM strutturato) e **claude-in-chrome** (automazione
screenshot/coordinate). Metrica: **turni** e **token** per completare il task —
non wall-clock.

## Risultati

| task | arm | turni | out tok | cache read | $/run |
|---|---|---:|---:|---:|---:|
| **form** | **chrome-bridge** | **6.0** | **822** | **249k** | **0.21** |
| form | claude-in-chrome | 16.5 | 2004 | 570k | 0.48 |
| **heavy** | **chrome-bridge** | **4.0** | **408** | **154k** | **0.18** |
| heavy | claude-in-chrome | 11.0 | 1374 | 427k | 0.41 |

**chrome-bridge è ~2.3–2.8× più efficiente su entrambi i task**: meno turni,
meno token, meno costo. Vantaggio consistente sia su interazione (form) sia su
estrazione da DOM pesante (heavy).

| | form | heavy |
|---|---:|---:|
| turni | 2.75× | 2.75× |
| token output | 2.4× | 3.4× |
| cache read | 2.3× | 2.8× |
| costo | 2.3× | 2.3× |

## Setup

- Modello: `claude-sonnet-5`, `claude -p` headless, output JSON.
- 2 task, 2 run per arm (`n=2` — campione piccolo: direzione, non precisione).
- Pagine servite in locale (`bench/form.html`, `bench/heavy.html`) su `http://localhost:8099`.
- Harness: [`run-bench.sh`](./run-bench.sh). Risultati grezzi in [`results/`](./results/).

### Task

- **form** — compila 6 campi + checkbox + submit, riporta il testo di conferma.
- **heavy** — tabella catalogo 1500 righe: trova la riga `SKU-0777`
  (nome/categoria/prezzo/stock) e conta le righe totali.

### Caveat metodologici

- L'arm `cic` riceve un `--append-system-prompt` che neutralizza l'istruzione
  di progetto "usa chrome-bridge" (senza, il subprocess rifiuta i tool cic).
  Impatto: ~40 token di system, trascurabile.
- Entrambi gli arm portano gli stessi hook di sessione (costante): il confronto
  è **relativo**; i numeri assoluti sono gonfiati di pari misura.

## Perché chrome-bridge è più efficiente

- **Rappresentazione DOM compatta.** `get_interactives` ritorna ref
  (`n1, n2…`) usabili direttamente come target di click/type, contro il ciclo
  screenshot → lettura coordinate → click di claude-in-chrome. Meno round-trip,
  payload minuscolo.
- **Lavoro lato server, non lato modello.** Il collo di bottiglia token è il
  payload estensione → modello, non estensione → server (localhost, gratis).
  Filtrare / proiettare / paginare lato server tiene l'output piccolo anche su
  tabelle enormi: `extract_table` con `where` risolve "trova SKU-0777 su 1500
  righe" in **1 call su 1 riga**, invece di paginare l'intera tabella.
