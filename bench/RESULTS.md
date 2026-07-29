# chrome-bridge vs claude-in-chrome — benchmark token/turni

Confronto a parità di modello (Claude Sonnet 5) e task tra **chrome-bridge**
(MCP via estensione, DOM strutturato) e **claude-in-chrome** (automazione
screenshot/coordinate). Metrica: **turni** e **token** per completare il task —
non wall-clock.

> **Revisione 2026-07-25.** Una rilettura di tutte le run in [`results/`](./results/)
> ha mostrato che la versione precedente di questa pagina pubblicava, per il task
> `heavy`, solo le due run post-fix (`bridge-heavy-fix-1/2`) confrontate con un
> arm `cic` non ri-eseguito, senza dirlo. La riga `heavy` è stata ritirata dal
> confronto e la regola di inclusione è ora scritta sotto. Il vantaggio sul task
> `form` è confermato e invariato.

## Regola di inclusione (fissata, non discrezionale)

1. Un confronto è pubblicabile solo tra run **appaiate**: stessa data, stessa
   versione di server ed estensione per entrambi gli arm.
2. Dentro un set appaiato si includono **tutte** le run, comprese quelle
   sfavorevoli. Escludere una run richiede una causa esterna al risultato
   (es. sessione fallita per browser non locale) e va annotata qui.
3. Si riportano **mediana, min-max e n**, non la sola media: con n=2 la media
   nasconde una varianza che nei nostri dati arriva a 7,4×.

## Risultato pubblicabile — task `form`

Set appaiato del 2026-07-13, server+estensione 1.6.0, tutte le run incluse (n=2 per arm):

| task | arm | turni | out tok | cache read | $/run |
|---|---|---:|---:|---:|---:|
| **form** | **chrome-bridge** | **6,0** (6-6) | **822** (791-852) | **249k** | **0,211** |
| form | claude-in-chrome | 16,5 (16-17) | 2004 (1939-2070) | 570k | 0,481 |

| | rapporto |
|---|---:|
| turni | **2,75×** |
| token output | 2,44× |
| cache read | 2,29× |
| costo | **2,28×** |

## Task `heavy` — non confrontabile allo stato attuale

| run set | arm | turni | out tok | $/run |
|---|---|---:|---:|---:|
| 2026-07-13, v1.6.0 | chrome-bridge | 13,5 (12-15) | 2788 | 0,406 |
| 2026-07-13, v1.6.0 | claude-in-chrome | 11,0 (9-13) | 1374 | 0,414 |
| dopo il fix di `extract_table where` | chrome-bridge | 4,0 (4-4) | 408 | 0,178 |
| 2026-07-20, v1.7.0 | chrome-bridge | 6,0 (4-7) | 1019 | 0,251 |
| — | claude-in-chrome | *non ri-eseguito* | | |

Lettura onesta: sul set appaiato del 13/07 **chrome-bridge perdeva** sui turni
(13,5 contro 11,0) e pareggiava sul costo. Il fix di `extract_table` ha portato
il nostro lato a 4,0 turni, ma l'arm `cic` non è stato ri-eseguito su quella
versione, quindi **non esiste un rapporto pubblicabile** per questo task. Il
confronto tornerà qui quando entrambi gli arm gireranno sulla stessa versione.

Nota: l'harness girava senza `--caps`, quindi con 30 tool e **senza
`extract_table`** — cioè senza il tool a cui questa pagina attribuiva il merito.
Vedi "Limiti dell'harness".

## Setup

- Modello: `claude-sonnet-5`, `claude -p` headless, output JSON.
- Pagine servite in locale (`bench/form.html`, `bench/heavy.html`) su `http://localhost:8099`.
- Harness: [`run-bench.sh`](./run-bench.sh). Risultati grezzi, **tutti**, in [`results/`](./results/).
- Aggregazione: `python3 bench/aggregate.py` (stampa ogni run inclusa e ogni run scartata).

### Task

- **form** — compila 6 campi + checkbox + submit, riporta il testo di conferma.
- **heavy** — tabella catalogo 1500 righe: trova la riga `SKU-0777`
  (nome/categoria/prezzo/stock) e conta le righe totali.

### Run escluse, con causa

- `cic-form-17a` — la sessione si è accoppiata a un browser **remoto**
  (`isLocal:false`, macOS) mentre il server di test girava solo sulla macchina
  locale: ogni tab mostrava una pagina di errore. Causa esterna al risultato,
  esito conservato in `results/cic-form-17a.invalid-remote-browser`.

### Limiti dell'harness

Chiusi il 2026-07-25 — **le run già in `results/` precedono queste correzioni**,
quindi il prossimo giro non è confrontabile riga per riga con quelle vecchie:

- `run-bench.sh` ora passa `--caps` (default `all`, override con
  `CHROME_BRIDGE_CAPS`): prima misurava il set core, quindi **senza
  `extract_table`**, `accessibility_audit`, `web_vitals`, `save_page`.
- Ogni run scrive un `.meta.json` con versione di server, estensione, caps, data
  e versione di `claude`: un confronto fra versioni diverse non è più
  indistinguibile da uno appaiato.
- L'exit code è verificato: una run scaduta viene rinominata `.failed-exitN`
  invece di sparire riducendo `n` in silenzio.
- `aggregate.py` stampa run scartate, file fuori dal glob e un WARNING quando i
  due arm hanno `n` diverso.

Ancora aperti:

- `--output-format json` non registra le tool call: non si può attribuire il
  costo al singolo tool, che è la domanda centrale. Serve `stream-json`.
- Solo due task, entrambi di interazione/estrazione: manca un task di **debug**
  (console + network) e uno di navigazione SPA.

### Caveat metodologici

- L'arm `cic` riceve un `--append-system-prompt` che neutralizza l'istruzione
  di progetto "usa chrome-bridge" (senza, il subprocess rifiuta i tool cic).
  Impatto: ~40 token di system, trascurabile.
- Entrambi gli arm portano gli stessi hook di sessione (costante): il confronto
  è **relativo**; i numeri assoluti sono gonfiati di pari misura.
- **Il vantaggio è nel numero di giri, non nel costo per giro.** Misurato su 12
  run bridge: 41.985 token di cache read per turno (min 38.277, max 46.292)
  contro 36.613 di claude-in-chrome, e $0,0373 contro $0,0337 per turno.
  chrome-bridge costa *più* per turno e vince perché ne fa meno.

## Perché chrome-bridge fa meno giri

- **Rappresentazione DOM compatta.** `get_interactives` ritorna ref
  (`n1, n2…`) usabili direttamente come target di click/type, contro il ciclo
  screenshot → lettura coordinate → click di claude-in-chrome.
- **Batch dove esiste.** `fill_form` compila N campi e invia in una sola call:
  misurato, `navigate + fill_form + read_page` sono 3 call contro le 9 del
  percorso campo-per-campo, a parità di byte.
- **Lavoro lato server, non lato modello.** Il collo di bottiglia token è il
  payload estensione → modello, non estensione → server (localhost, gratis).
  `extract_table` con `where` risolve "trova SKU-0777 su 1500 righe" in
  **236 byte**, contro i 50.070 byte di `read_page` sulla stessa pagina.
