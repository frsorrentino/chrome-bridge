# chrome-bridge vs claude-in-chrome — benchmark token/turni

Confronto a parità di modello (Claude Sonnet 5) e task tra **chrome-bridge**
(MCP via estensione, DOM strutturato) e **claude-in-chrome** (automazione
screenshot/coordinate). Metrica: **turni** e **token** per completare il task —
non wall-clock.

## Regola di inclusione (fissata, non discrezionale)

1. Un confronto è pubblicabile solo tra run **appaiate**: stessa data, stessa
   versione di `claude`, stesso modello, e per l'arm chrome-bridge una sola
   versione di server ed estensione, dichiarata. L'arm `cic` non usa
   chrome-bridge, quindi i suoi risultati non dipendono da quella versione.
   *(Fino al 13/07 la regola chiedeva «stessa versione di server ed estensione
   per entrambi gli arm»: era un modo indiretto di dire «stesso giorno, stesso
   ambiente». Il 27/09 i due arm hanno girato in ore diverse dello stesso
   giorno, quindi la regola ora nomina quello che conta.)*
2. Dentro un set appaiato si includono **tutte** le run, comprese quelle
   sfavorevoli. Escludere una run richiede una causa esterna al risultato
   (es. sessione fallita per browser non locale) e va annotata qui.
3. Si riportano **mediana, min-max e n**, non la sola media: con n=2 la media
   nasconde una varianza che nei nostri dati arriva a 7,4×.

## Risultato pubblicabile — 1.25.1, set appaiato del 2026-09-29

- **chrome-bridge 1.25.1 in rilascio**, server del commit `32b230c`
  (estensione identica alla 1.25.0), `--launch --headless`, `--caps core` (43
  tool), `alwaysLoad: true`. Cambia solo il testo: descrizione della skill,
  che non si attiva più per il debug di una pagina, e una riga sul debug nelle
  istruzioni del server MCP. Run `v1251a`, 15:09-15:19.
- **Claude in Chrome**: le stesse run `v125b` della mattina (regola 1).
- n=5 per arm e per task, tutte le run incluse.

| task | arm | turni | out tok | cache read | $/run | risposta corretta |
|---|---|---:|---:|---:|---:|---:|
| **form** | **chrome-bridge** | **3,0** (3) | **462** (432-554) | **183k** (183-183k) | **0,155** (0,153-0,156) | 5/5 |
| form | claude-in-chrome | 14,0 (14-15) | 2488 (2161-2768) | 566k (554-625k) | 0,428 (0,410-0,448) | 5/5 |
| **heavy** | **chrome-bridge** | **3,0** (3-4) | **319** (302-341) | **182k** (182-182k) | **0,149** (0,149-0,150) | 5/5 |
| heavy | claude-in-chrome | 7,0 (5-7) | 1630 (1475-2756) | 457k (225-460k) | 0,506 (0,309-0,511) | 3/5 |
| **debug** | **chrome-bridge** | **3,0** (3-4) | **822** (759-997) | **182k** (181-252k) | **0,162** (0,161-0,175) | 5/5 |
| debug | claude-in-chrome | 28,0 (21-44) | 9742 (5924-12705) | 1307k (1076-2146k) | 0,688 (0,585-0,899) | 4/5 |

Rapporti cic/bridge sulle mediane:

| task | turni | token output | cache read | costo |
|---|---:|---:|---:|---:|
| form | **4,67×** | 5,39× | 3,09× | **2,76×** |
| heavy | **2,33×** | 5,11× | 2,51× | **3,39×** |
| debug | **9,33×** | 11,85× | 7,19× | **4,25×** |

Risposte corrette: 15/15 contro 12/15. `python3 bench/aggregate.py
bridge:v1251a cic:v125b` riproduce le tabelle.

- **Perché il debug passa da 6 a 3 turni.** Nelle 20 run debug precedenti
  della giornata la skill si caricava in 7 (6,6 turni medi con la skill, 4,6
  senza); qui in 0 su 5. Tutte e 5 le run fanno `navigate` e
  `get_css_styles`, una legge anche il sorgente con `http_request`.
- Form e heavy non cambiano rispetto alla 1.25.0 (3 turni, costo entro
  l'1%): la skill non si caricava già prima.

## Set della release 1.25.0 (commit `50bf457`) — superato dalla 1.25.1

- **chrome-bridge 1.25.0**, server ed estensione del commit `50bf457`, quello
  della release (versione 1.25.0 nei sette file), `--launch --headless`,
  `--caps core` (43 tool, il default distribuito), `alwaysLoad: true` come nel
  plugin. Skill: quella del repo allo stesso commit (`.claude/skills/chrome-bridge`),
  cioè quella del mattino più la riga su `get_interactives since`. Run `v125f`,
  14:21-14:34.
- **Claude in Chrome**: le run `v125b` della mattina (sotto). Il loro arm non
  usa chrome-bridge, quindi il cambio di versione non le tocca (regola 1):
  stessa data, stesso `claude` 2.1.284, stesso `claude-sonnet-5`.
- n=5 per arm e per task, tutte le run incluse.

| task | arm | turni | out tok | cache read | $/run | risposta corretta |
|---|---|---:|---:|---:|---:|---:|
| **form** | **chrome-bridge** | **3,0** (3) | **479** (441-555) | **183k** (140-183k) | **0,154** (0,154-0,317) | 5/5 |
| form | claude-in-chrome | 14,0 (14-15) | 2488 (2161-2768) | 566k (554-625k) | 0,428 (0,410-0,448) | 5/5 |
| **heavy** | **chrome-bridge** | **3,0** (3) | **292** (272-356) | **182k** (182-182k) | **0,149** (0,148-0,149) | 5/5 |
| heavy | claude-in-chrome | 7,0 (5-7) | 1630 (1475-2756) | 457k (225-460k) | 0,506 (0,309-0,511) | 3/5 |
| **debug** | **chrome-bridge** | **6,0** (4-8) | **1426** (1015-2282) | **339k** (183-492k) | **0,219** (0,166-0,262) | 5/5 |
| debug | claude-in-chrome | 28,0 (21-44) | 9742 (5924-12705) | 1307k (1076-2146k) | 0,688 (0,585-0,899) | 4/5 |

Rapporti cic/bridge sulle mediane (>1 = chrome-bridge ne usa meno):

| task | turni | token output | cache read | costo |
|---|---:|---:|---:|---:|
| form | **4,67×** | 5,19× | 3,10× | **2,77×** |
| heavy | **2,33×** | 5,58× | 2,51× | **3,40×** |
| debug | **4,67×** | 6,83× | 3,85× | **3,15×** |

Risposte corrette: 15/15 contro 12/15. `python3 bench/aggregate.py
bridge:v125f cic:v125b` riproduce le tabelle.

- **Debug, un turno in più della mattina** (6 contro 5 di `v125d`): in 3 run su 5 il modello carica la skill (`Skill` 0,6 per run)
  e in 4 su 5 legge il sorgente con `http_request` (0,8). Le due serie si
  sovrappongono (4-8 contro 3-5): è varianza del modello, non un cambio del
  server, che nel debug non tocca `click` né `press_key`.
- **Stesso commit con tutti i 60 tool** (`--caps all`, run `v125e`,
  12:18-14:19): turni 3 / 3 / 5, costo 2,70× / 3,33× / 3,65×, 15/15.
  Lanciata per errore senza `CHROME_BRIDGE_CAPS=core`; la si tiene come
  controllo: 17 tool in più nello schema non cambiano il quadro.
- **Due tentativi di heavy-5 in `v125e` esclusi, con causa**
  (`bench/results/excluded-0929/bridge-heavy-v125e-5*`): il Chrome headless
  lanciato dal server non si è collegato entro i 30 s dell'attesa, mentre un
  render video di un'altra sessione teneva il carico a 11-17. Misurato subito
  dopo sullo stesso Chromebook: 59 s e oltre 60 s sotto carico, 9-27 s a
  carico 8. Sul PC Windows, per escludere una regressione, 1.24.0 e 1.25.0 si
  collegano in 1,1-1,3 s (6 prove ciascuna). La run è stata rifatta a carico
  3,3.

## Set del mattino del 2026-09-29 (1.25.0 in sviluppo) — superato dalla release

- **chrome-bridge 1.25.0 in sviluppo**, server ed estensione del commit
  `a9ea298` (in `package.json` ancora 1.24.0: il numero si alza al rilascio),
  `--launch --headless`, `--caps core` (43 tool), `alwaysLoad: true` come nel
  plugin. Skill: modulo e pagina pesante con quella del commit `28d272f`, che
  non è mai stata invocata in quelle 10 run; debug con quella di `97f48d1`
  (ricette di debug nel nucleo). La serie debug con la skill precedente
  (`v125c`, 6 turni di mediana) resta in `bench/results/`.
- **Claude in Chrome**: estensione ufficiale nel Chrome del Chromebook, unico
  browser collegato (deviceId `3865739a…`), finestra visibile.
- Entrambi gli arm: `claude` 2.1.284, `claude-sonnet-5`, stessa mattina
  (bridge 08:32-08:43, cic 08:42-09:57).
- n=5 per arm e per task; tre task (form, heavy e il nuovo **debug**: la
  pagina di checkout di `bench/debug/` con una richiesta che fallisce con 404,
  un errore da riportare al sorgente e un pulsante invisibile per una
  variabile CSS non definita).

| task | arm | turni | out tok | cache read | $/run | risposta corretta |
|---|---|---:|---:|---:|---:|---:|
| **form** | **chrome-bridge** | **3,0** (3) | **484** (424-606) | **186k** (142-186k) | **0,163** (0,160-0,320) | 5/5 |
| form | claude-in-chrome | 14,0 (14-15) | 2488 (2161-2768) | 566k (554-625k) | 0,428 (0,410-0,448) | 5/5 |
| **heavy** | **chrome-bridge** | **3,0** (3) | **298** (286-330) | **185k** (184-185k) | **0,156** (0,153-0,158) | 5/5 |
| heavy | claude-in-chrome | 7,0 (5-7) | 1630 (1475-2756) | 457k (225-460k) | 0,506 (0,309-0,511) | 3/5 |
| **debug** | **chrome-bridge** | **5,0** (3-5) | **1317** (791-1476) | **261k** (186-269k) | **0,198** (0,172-0,216) | 5/5 |
| debug | claude-in-chrome | 28,0 (21-44) | 9742 (5924-12705) | 1307k (1076-2146k) | 0,688 (0,585-0,899) | 4/5 |

Rapporti cic/bridge sulle mediane (>1 = chrome-bridge ne usa meno):

| task | turni | token output | cache read | costo |
|---|---:|---:|---:|---:|
| form | **4,67×** | 5,14× | 3,05× | **2,63×** |
| heavy | **2,33×** | 5,47× | 2,47× | **3,25×** |
| debug | **5,60×** | 7,40× | 5,01× | **3,47×** |

Risposte corrette: chrome-bridge 15/15, Claude in Chrome 12/15.
`python3 bench/aggregate.py bridge:v125c cic:v125b` (form, heavy) e
`python3 bench/aggregate.py bridge:v125d cic:v125b` (debug) riproducono le
tabelle.

### Lettura onesta (29/09)

- **Dove va il turno.** chrome-bridge chiude form e heavy con due chiamate
  (`navigate` → `fill_form` oppure `navigate` → `extract_table`) più la
  risposta: è il minimo. Claude in Chrome nel form compila un campo per volta
  (`form_input` 5,0 per run) e guarda con `computer` (1,6 screenshot per run);
  nel heavy legge 40 KB di testo con `get_page_text`.
- **Debug.** chrome-bridge: `navigate` riporta già l'errore riportato al
  sorgente, con la riga di codice, e la richiesta fallita; `get_css_styles`
  segnala `--brand-primary` non definita. Claude in Chrome ci arriva con 14
  chiamate a `javascript_tool` e 4 a `read_network_requests` per run.
- **Asimmetria dell'harness, a favore di Claude in Chrome.** L'arm cic gira
  con `--permission-mode bypassPermissions` e nel debug ha usato anche `Bash`
  (1,0 per run) e `Read` (0,6) per leggere il sorgente sul disco. L'arm bridge
  ha solo i tool di chrome-bridge: i suoi `Read` sono negati.
- **Errori di Claude in Chrome.** heavy-1 termina con «Fatto, tab chiuso.»
  senza i dati; heavy-4 riporta il prezzo 282.0 invece di 292.0; debug-2
  indica la riga 9 invece della 10.
- **Limiti.** Una macchina (Chromebook, Crostini), un modello, pagine locali,
  n=5. Il costo è `total_cost_usd` di `claude -p`, a listino API.

### Run escluse il 29/09, con causa

Alle 09:04 la macchina ha perso la risoluzione DNS. Sei run di Claude in
Chrome delle tornate 4 e 5 sono fallite; le due tornate sono state rifatte
per intero alle 09:47-09:57, con la rete tornata. Le run sostituite sono in
`bench/results/excluded-0929/`:

- `cic-{form,heavy,debug}-v125b-5` e `cic-debug-v125b-4`: «API Error: Can't
  reach the API server (EAI_AGAIN)», nessun tool chiamato;
- `cic-heavy-v125b-4`: timeout a 360 s dopo 10 `api_retry` nel flusso;
- `cic-form-v125b-4`: timeout a 360 s alle 09:04, a metà compilazione, senza
  `api_retry` registrati. La causa probabile è la stessa interruzione, ma non
  è dimostrata. Contata come fallita, Claude in Chrome farebbe 5 moduli giusti
  su 6 tentativi.

## Set appaiato del 2026-09-27 (1.23.2) — superato dal 29/09

- **chrome-bridge 1.23.2** (server del commit `17e7f3d`, pubblicato il
  27/09/2026), `--launch --headless`, `--caps all`. L'estensione usata nelle
  run è quella del repo, identica alla 1.23.0; nella release il manifest resta
  a 1.23.0 perché il codice dell'estensione non cambia.
- Gli hash `git_head` nei `.meta.json` del 27/09 (`e0511b9`, `d6a6e25`,
  `56bbdc1`, `9078444`) sono quelli al momento della run. Gli ultimi tre erano
  commit locali, riscritti prima del push per togliere dagli stream gli output
  degli hook di sessione. Il contenuto di `server/` ed `extension/` è identico:
  `9078444` corrisponde a `17e7f3d`, `56bbdc1` è lo stato 1.23.1 intermedio,
  descritto in `CHANGELOG.md`.
- **Claude in Chrome**: estensione ufficiale nel Chrome di Franz, finestra
  visibile.
- Entrambi gli arm: `claude` 2.1.283, `claude-sonnet-5`, stesso giorno
  (bridge 16:21-16:25, cic 15:59-16:20).
- n=5 per arm e per task; task alternati per round; una run alla volta, con
  carico sotto 6.

| task | arm | turni | out tok | cache read | $/run | risposta corretta |
|---|---|---:|---:|---:|---:|---:|
| **form** | **chrome-bridge** | **6,0** (4-6) | **734** (611-786) | **269k** (190-270k) | **0,225** (0,177-0,228) | 5/5 |
| form | claude-in-chrome | 15,0 (10-16) | 2233 (1924-3235) | 624k (561-690k) | 0,432 (0,415-0,451) | 5/5 |
| **heavy** | **chrome-bridge** | **6,0** (4-6) | **423** (407-604) | **267k** (187-268k) | **0,217** (0,166-0,220) | 5/5 |
| heavy | claude-in-chrome | 7,0 (7-9) | 1474 (1099-2235) | 457k (455-484k) | 0,501 (0,385-0,515) | 4/5 |

Rapporti cic/bridge sulle mediane (>1 = chrome-bridge ne usa meno):

| task | turni | token output | cache read | costo |
|---|---:|---:|---:|---:|
| form | **2,50×** | 3,04× | 2,32× | **1,92×** |
| heavy | **1,17×** | 3,48× | 1,71× | **2,31×** |

`python3 bench/aggregate.py bridge:0927v1232 cic:0927-` riproduce le tabelle.
Una risposta è «corretta» se il testo finale della run contiene tutti i valori
attesi (`EXPECT` in `aggregate.py`). `cic-heavy-0927-8` dà la risposta giusta
in un messaggio intermedio, poi chiude la scheda e termina con «Fatto, tab
chiuso.». Con `claude -p` al chiamante arriva solo il testo finale, quindi
conta come mancata.

### Lettura onesta

- **Il vantaggio sul `form` regge, un po' più stretto del 13/07.** Allora era
  2,75× turni e 2,28× costo, su 1.6.0 con n=2; oggi è 2,50× e 1,92×. Il costo
  cresce meno dei turni perché un turno di chrome-bridge porta più contesto
  fisso: 45k token di cache read per turno contro 42k di cic, con `--caps all`
  (60 tool) e la skill.
- **Sul `heavy` il vantaggio è nel costo, quasi non nei turni.** cic risolve
  in 7 turni con `get_page_text` (40 KB di testo in contesto) più un conteggio
  in JavaScript. chrome-bridge lo fa con un `extract_table` da 0,2 KB. Stessi
  turni o quasi, ma cic rilegge 65k token per turno contro 45k: 2,31× il costo.
- **La skill di chrome-bridge costa 2 turni quando il modello la carica.** In
  3 run su 5 per task il modello invoca la skill `chrome-bridge` prima di
  lavorare. Senza skill le run fanno 4 turni ($0,17-0,18), con la skill 6
  ($0,22-0,23). Il minimo di 4 turni è il percorso diretto: `ToolSearch`,
  `navigate`, un'azione, risposta. La mediana di 6 è il prezzo della skill,
  che su task così semplici non aggiunge nulla.
- **cic non ha mai caricato una skill** (0 su 10). Usa 1,8 screenshot per run
  nel `form` e 0,2 nel `heavy`.

### Run escluse, con causa

- `cic-form-0927-3`, `cic-heavy-0927-3`, `cic-heavy-0927-5`, `cic-heavy-0927-6`
  — il modello rifiuta i tool di Claude in Chrome citando il CLAUDE.md globale
  di Franz («usa chrome-bridge; se non è caricato avvisa, NON fare fallback a
  claude-in-chrome»), nonostante l'`--append-system-prompt` dell'harness. È
  successo in 4 tentativi su 14: 2-3 turni, nessuna azione nel browser.
  Causa esterna al risultato: l'istruzione è una preferenza personale
  dell'ambiente, non un limite di Claude in Chrome. Le run sono conservate come
  `*.invalid-claude-md-refusal` e rimpiazzate da `-6`, `-7` e `-8` finché n=5.
- `*-smoke*`: prove dell'harness prima dei giri, fuori da ogni set.
  `cic-form-smoke` documenta il blocco delle 15:10: «Browser extension is not
  connected».

### Dove va il costo, per tool

Da `stream-json`: chiamate per run e dimensione del `tool_result` che entra nel
contesto. Le immagini sono contate a parte, perché si pagano a pixel (circa
larghezza×altezza/750 token, ~1.600 token per uno screenshot 1450×840) e non a
byte di base64.

| task | arm | tool principali (chiamate/run, testo/run) |
|---|---|---|
| form | chrome-bridge | `navigate` 1,0 (0,5 KB) · `fill_form` 1,0 (1,0 KB, con `after_submit`) · `ToolSearch` 1,0 · skill 0,6 |
| form | cic | `form_input` 4,0 (0,7 KB) · `computer` 2,8 (1,8 screenshot) · `read_page` 1,2 · `get_page_text` 1,0 · `navigate` 1,2 · `tabs_close_mcp` 1,0 |
| heavy | chrome-bridge | `navigate` 1,0 (0,1 KB) · `extract_table` 1,0 (0,2 KB) · `ToolSearch` 1,0 · skill 0,6 |
| heavy | cic | `get_page_text` 0,8 (**40,3 KB**) · `javascript_tool` 1,0 · `navigate` 1,0 · `ToolSearch` 2,0 |

### Prima dei fix: chrome-bridge 1.23.0 → 1.23.1 → 1.23.2, stesso giorno

Il giro del 27/09 è partito su 1.23.0. Le run hanno mostrato cinque difetti che
costavano turni o risposte. Corretti in due passi, stesso harness e stessa
`--launch`, n=5 per task:

| versione | task | turni | $/run | risposta corretta | turni persi per difetti |
|---|---|---:|---:|---:|---|
| 1.23.0 | form | 8,0 (5-13) | 0,233 (0,186-0,348) | 5/5 | race di connessione in 2 run (+4-6 turni) |
| 1.23.0 | heavy | 4,0 (3-4) | 0,164 (0,152-0,178) | **3/5** | race in 2 run: resa con risposta sbagliata |
| 1.23.1 | form | 6,0 (4-6) | 0,223 (0,174-0,224) | 5/5 | `checked` rifiutato in 1 run |
| 1.23.1 | heavy | 6,0 (4-6) | 0,213 (0,164-0,215) | 5/5 | `where` `sku`≠`SKU` in 3 run |
| **1.23.2** | form | 6,0 (4-6) | 0,225 (0,177-0,228) | 5/5 | nessuno |
| **1.23.2** | heavy | 6,0 (4-6) | 0,217 (0,166-0,220) | 5/5 | nessuno |

Risposte corrette: **8/10 → 10/10 → 10/10**. I difetti, tutti lato server
(dettaglio in `CHANGELOG.md`):

1. **1.23.1** — un comando inviato prima che l'estensione si colleghi aspetta,
   entro un limite, invece di fallire subito. Con `--launch` il primo
   `navigate` arrivava prima del Chrome appena avviato.
2. **1.23.1** — `fill_form` accetta i `ref` che `navigate` restituisce; prima
   lo schema li rifiutava.
3. **1.23.1** — `fill_form` con invio restituisce `after_submit`: url, titolo
   e il testo nuovo della pagina. Prima servivano 1-3 turni per leggere la
   conferma.
4. **1.23.2** — `extract_table` `where` riconosce i nomi di colonna senza
   badare a maiuscole e spazi.
5. **1.23.2** — `fill_form` accetta `checked: true|false` per checkbox e
   radio.

La mediana di `heavy` sale da 4 a 6 fra 1.23.0 e 1.23.1 senza che i fix
c'entrino: le run con la skill passano da 0/5 a 3/5 (vedi sopra). Sul `heavy`
1.23.0 le tre run senza race (e senza skill) hanno 4 turni, come le due di
1.23.2 senza skill.

## Setup

- Modello: `claude-sonnet-5`, `claude -p` headless, `--output-format
  stream-json --verbose`.
- Pagine servite in locale (`bench/form.html`, `bench/heavy.html`) su
  `http://localhost:8099` (`python3 -m http.server 8099 --bind 127.0.0.1 -d bench`).
- Harness: [`run-bench.sh`](./run-bench.sh) per una run,
  [`run-series.sh`](./run-series.sh) per N round di un arm. Risultati grezzi,
  **tutti**, in [`results/`](./results/): `.json` (riga `result`),
  `.stream.jsonl` (ogni tool call), `.meta.json` (versioni, commit, caps).
- Aggregazione: `python3 bench/aggregate.py [prefisso | arm:prefisso …]`
  (stampa ogni run inclusa e ogni run scartata).

### Task

- **form** — compila 6 campi + checkbox + submit, riporta il testo di conferma.
- **heavy** — tabella catalogo 1500 righe: trova la riga `SKU-0777`
  (nome/categoria/prezzo/stock) e conta le righe totali.

### Ambiente del 27/09

- Macchina: Chromebook ARM a 8 core, 6,6 GB di RAM. Claude Code gira nel
  container Crostini, Chrome sull'host ChromeOS.
- L'arm `cic` pilota il Chrome di Franz, con la finestra visibile e senza altri
  usi durante le run. `list_connected_browsers` risponde `isLocal:false` anche
  per questo Chrome, perché container e host hanno sistemi operativi diversi.
  L'identità è stata verificata: una scheda aperta da Claude in Chrome
  compariva nella lista di schede vista da chrome-bridge. `run-series.sh`
  accetta quindi un solo browser, locale oppure con `CIC_DEVICE_ID`, e lo
  ricontrolla dopo ogni run.
- L'arm bridge lancia a ogni run un Chrome headless nuovo con l'estensione del
  repo (`--launch --headless`).

### Limiti dell'harness

Chiusi il 2026-07-25:

- `run-bench.sh` passa `--caps` (default `all`, override con
  `CHROME_BRIDGE_CAPS`): prima misurava il set core, quindi **senza
  `extract_table`**, `accessibility_audit`, `web_vitals`, `save_page`.
- Ogni run scrive un `.meta.json` con versione di server, estensione, caps, data
  e versione di `claude`.
- L'exit code è verificato: una run scaduta viene rinominata `.failed-exitN`
  invece di sparire riducendo `n` in silenzio.
- `aggregate.py` stampa run scartate, file fuori dal glob e un WARNING quando i
  due arm hanno `n` diverso.

Chiusi il 2026-09-27:

- `stream-json`: ogni tool call e ogni tool result finiscono in
  `results/*.stream.jsonl`, e `aggregate.py` attribuisce chiamate, errori,
  testo e immagini al singolo tool. Il `.json` finale è la riga `type=result`
  dello stream, identica a quella che scriveva `--output-format json`: il
  comportamento dei due arm non cambia.
- `aggregate.py` riporta mediana e min-max anche di cache read e costo, i
  rapporti cic/bridge sulle mediane, quante risposte sono corrette (contate,
  non escluse) e accetta un prefisso per arm.
- Il `.meta.json` registra anche commit e stato di `server/` ed `extension/`.
- `run-series.sh`: N round di un arm, controllo di carico, sonda
  `list_connected_browsers` per `cic`.

Ancora aperti:

- **Il CLAUDE.md globale dell'ambiente contamina l'arm `cic`**: 4 rifiuti su
  14 tentativi, esclusi e rimpiazzati. Un `--append-system-prompt` non basta.
  Rimedio possibile: far girare l'arm `cic` con un utente o una home senza quel
  CLAUDE.md. Va fatto per entrambi gli arm, perché anche hook e skill cambiano
  il costo.
- Solo due task, entrambi di interazione/estrazione: manca un task di **debug**
  (console + network) e uno di navigazione SPA.
- Browser diversi per i due arm: headless lanciato per chrome-bridge, headed
  già aperto per cic. La race di connessione che questo causava è chiusa in
  1.23.1.

### Caveat metodologici

- L'arm `cic` riceve un `--append-system-prompt` che neutralizza l'istruzione
  di progetto "usa chrome-bridge". Impatto: ~40 token di system, trascurabile.
  Non sempre basta: vedi le run escluse.
- Entrambi gli arm portano gli stessi hook di sessione e lo stesso CLAUDE.md
  (costante): il confronto è **relativo**, e i numeri assoluti sono gonfiati
  di pari misura.
- **Il costo per turno non è uguale.** Il 27/09 chrome-bridge rilegge ~45k
  token di cache read per turno su entrambi i task. cic ne rilegge ~42k sul
  `form` e ~65k sul `heavy`, dove porta in contesto il testo della tabella.

## Perché chrome-bridge fa meno giri

- **Rappresentazione DOM compatta.** `navigate` restituisce già i ref
  (`n1, n2…`) dei campi, usabili come target di `click`, `type_text`,
  `fill_form`: niente ciclo screenshot → coordinate → click.
- **Batch dove esiste.** `fill_form` compila N campi, invia e, da 1.23.1,
  restituisce il testo nuovo della pagina in una sola call. cic fa una
  `form_input` per campo (4 per run) più screenshot di controllo.
- **Lavoro lato server, non lato modello.** Il collo di bottiglia token è il
  payload estensione → modello, non estensione → server (localhost, gratis).
  `extract_table` con `where` risolve "trova SKU-0777 su 1500 righe" in
  0,2 KB, contro i 40 KB di `get_page_text` di cic sulla stessa pagina.

## Storico

### Revisione del 2026-07-25

Una rilettura di tutte le run in [`results/`](./results/) aveva mostrato che la
versione precedente di questa pagina pubblicava, per il task `heavy`, solo le
due run post-fix (`bridge-heavy-fix-1/2`) confrontate con un arm `cic` non
ri-eseguito, senza dirlo. La riga `heavy` era stata ritirata e la regola di
inclusione scritta.

### Set appaiato del 2026-07-13 — sostituito dal 27/09

Server+estensione 1.6.0, harness senza `--caps` (30 tool, **senza
`extract_table`**), `--output-format json`, tutte le run incluse, n=2 per arm:

| task | arm | turni | out tok | cache read | $/run |
|---|---|---:|---:|---:|---:|
| form | chrome-bridge | 6,0 (6-6) | 822 (791-852) | 249k | 0,211 |
| form | claude-in-chrome | 16,5 (16-17) | 2004 (1939-2070) | 570k | 0,481 |
| heavy | chrome-bridge | 13,5 (12-15) | 2788 | — | 0,406 |
| heavy | claude-in-chrome | 11,0 (9-13) | 1374 | — | 0,414 |

Rapporti sul `form`: 2,75× turni, 2,44× token output, 2,29× cache read, 2,28×
costo. Sul `heavy` chrome-bridge **perdeva** sui turni (13,5 contro 11,0) e
pareggiava sul costo.

Run bridge non appaiate dello stesso periodo: dopo il fix di `extract_table
where`, 4,0 turni / $0,178 (`bridge-heavy-fix-1/2`); il 2026-07-20, v1.7.0, 6,0
turni (4-7) / $0,251 (`*-17a/b/c`). `cic-form-17a` era esclusa: la sessione si
era accoppiata a un browser remoto macOS che non raggiungeva `localhost:8099`
(esito in `results/cic-form-17a.invalid-remote-browser`).

Sulle run di allora (12 run bridge): 41.985 token di cache read per turno contro
36.613 di claude-in-chrome, $0,0373 contro $0,0337 per turno.
