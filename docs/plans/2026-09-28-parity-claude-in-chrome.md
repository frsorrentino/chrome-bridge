# Piano — parità con Claude in Chrome, e oltre

Stato: proposta per Franz, 2026-09-28 sera. Nessun codice. Brief:
`BRIEF-2026-09-28-parita-claude-in-chrome.md`.

Fonti dei fatti qui sotto:
- schemi dei 60 tool letti da `registerTools` (`server/tools.js`), non dalla memoria;
- manifest in `extension/manifest.json`;
- connessione in `server/ws-manager.js`;
- log del benchmark appaiato del 27/09 (`bench/results/cic-*.stream.jsonl`, run di Claude in Chrome su questo Chromebook).

## 1. Tabella delle differenze

| Claude in Chrome | chrome-bridge oggi | Stato |
|---|---|---|
| `navigate` | `navigate`, che restituisce già i ref | meglio: un turno in meno |
| `read_page` (albero a11y con ref) | `get_interactives`, `read_page mode:accessibility` | pari |
| `get_page_text` | `read_page` text/markdown con `max_length`, `save_to` | meglio: nel benchmark heavy CiC legge 40 KB di testo |
| `find` (linguaggio naturale) | `get_interactives` + `find_text` (ref degli elementi vicini) | pari nell'esito, diverso nel metodo (§2.8) |
| `form_input` (un campo per chiamata) | `fill_form`: N campi e submit in una chiamata | meglio: form 2,50× turni in meno |
| `computer`: screenshot, zoom | `screenshot`, `element_screenshot` con `region` e `scale` | pari |
| `computer`: click, drag, hover a coordinate x,y | click/hover/drag solo per selettore o ref; `scroll` accetta x,y | **manca** (§2.3) |
| `computer`: input fidato (debugger) | eventi sintetici, `isTrusted:false` | **peggio** (§2.2) |
| `computer`: key, type | `press_key`, `type_text` (mode `keys`) | pari, ma sintetici |
| `browser_batch` | nessuno | **manca** (§2.4) |
| `gif_creator` | nessuno; `session_record` registra comandi, non immagini | **manca** (§2.1) |
| `javascript_tool` | `execute_js` (timeout, `save_to`, taglio JSON valido) | pari; da noi serve il toggle «Allow user scripts» |
| `read_console_messages` | `read_console` con source map (vera dalla 1.24.0) | meglio |
| `read_network_requests` | `monitor_network` (page/browser/websocket, HAR) + `network_rules` | meglio |
| `resize_window` | `viewport_resize`, `window_layout`, `tile_windows`, `move_tab` | meglio |
| `tabs_context/create/close` | `get_tabs`, `create_tab`, `tab_action` | pari |
| `file_upload` | `upload_file` (dal disco, chiavi rifiutate) | pari |
| `upload_image` (uno screenshot dentro un input o una drop zone) | `screenshot save_to` + `upload_file`: due chiamate | peggio di un turno (§2.9) |
| `shortcuts_list/execute` | `session_record` + `chrome-bridge replay` (CLI a zero token, con variabili) | meglio per ripetere, **manca** il lancio da MCP (§2.6) |
| `list_connected_browsers` / `select` / `switch` | un solo browser per server | **manca** (§2.5) |
| approvazione delle azioni integrata | regole `permissions` di Claude Code, non documentate da noi | **peggio**, perché non documentato (§2.7) |

## 2. Proposta per ogni differenza

Costi: S sotto 1 giorno, M 1-3 giorni, L oltre.

### 2.1 Registrazione GIF e video — S poi M

- **A, S, nessun permesso nuovo.** Tool `record` (start/stop/save):
  - una cattura con `captureVisibleTab` a ogni azione, più una ogni 500 ms fra le azioni. Il limite di Chrome è 2 catture al secondo, e noi abbiamo già il pacing a 520 ms;
  - sovrapposizione del punto cliccato e del nome del tool (quello che fa `gif_creator`);
  - codifica GIF sul server in JavaScript puro (per esempio `gifenc`), senza obbligare a installare ffmpeg; MP4/WebM solo se ffmpeg è presente.

  Limite: sono una sequenza di fotogrammi, non un video fluido. Per spiegare un bug basta.
- **B, M, video vero.** `tabCapture` + `MediaRecorder` in un documento `offscreen`, 30 fps, WebM.
  - Permessi nuovi: `tabCapture`, `offscreen`.
  - Limite da verificare: `tabCapture.getMediaStreamId` vuole che l'utente abbia invocato l'estensione (clic sull'icona) per quella scheda. Si innesta bene su `handoff` («premi l'icona per avviare la registrazione»).
  - Impatto sulla revisione Store: permessi in più, da verificare se compaiono nuovi avvisi all'installazione.

### 2.2 Input fidato via `chrome.debugger` — M, e una decisione di prodotto

- **`debugger` non può essere un permesso opzionale.** Lo dice la documentazione di Chrome, e lo avevamo verificato nell'analisi del 25/07. Quindi il brief va corretto: non si può chiedere a runtime. Va nel manifest, e questo comporta:
  - avviso all'installazione («leggere e modificare tutti i dati…» e accesso al debugger);
  - revisione Store più severa;
  - estensione **disattivata per tutti gli utenti attuali** finché non accettano il permesso nuovo. È l'effetto più pesante.
- **ChromeOS:** prova indiretta che funziona. Nel benchmark del 27/09 `computer left_click` di Claude in Chrome ha risposto «Clicked at (48, 259)» in 5 run su 5 sul Chrome host di questo Chromebook, e quei click passano da `Input.dispatchMouseEvent`.
  - Nessuna nota nostra dice il contrario: l'unico limite scritto è «non opzionale».
  - Prova diretta, 2 minuti di Franz: caricare da `chrome://extensions` un'estensione di prova con `debugger` che fa attach, un click e detach su una scheda. Misuriamo se la barra «sta eseguendo il debug» compare e quanto resta.
- **Progetto:** fallback, non default.
  - `click`, `type_text` e `press_key` provano l'evento sintetico. Se `page_changed` non vede effetti e il tool riceve `trusted:true` (o una regola automatica sui widget noti), fa attach → `Input.dispatch*` → detach.
  - La barra compare solo per la durata dell'azione.
- **Tre strade, decide Franz:**
  1. stesso item Store (perde gli utenti che non riaccettano);
  2. **secondo item** «Chrome Bridge — trusted input» con `debugger`, sceglibile;
  3. solo launch mode, dove il browser lanciato ha già `--remote-debugging-port` e il server può usare CDP diretto senza toccare lo Store.

  Consiglio 3 subito (costo S sul server) e 2 dopo.

### 2.3 Azioni a coordinate — S (sintetiche), poi fidate con §2.2

- **Parametri nuovi:** `x`,`y` su `click`, `hover`, `drag_and_drop` (`from_x/from_y/to_x/to_y`).
- **Nel frame:** `document.elementFromPoint` + eventi pointer/mouse con `clientX/Y` giusti. Basta per canvas e widget che leggono le coordinate.
- **Trappola nota** (vista con la Dev Console il 13/07, dpr 1,25): le coordinate dello screenshot non sono CSS px. `screenshot` deve restituire `css_scale`, cioè il fattore fra pixel dell'immagine (ridotta a ≤1568 px) e CSS px, e i tool devono accettare coordinate in pixel-immagine.
- **Con §2.2** le stesse coordinate diventano input fidato.

### 2.4 Batch — S, solo server

- **Tool `batch`:** `steps: [{tool, args}]` eseguiti in sequenza sul server, stop al primo errore (o `continue_on_error`), una riga di esito per passo. Niente modifiche all'estensione, quindi release senza Store.
- **Valore realistico:** meno di quanto sembri. `navigate` con i ref e `fill_form` tolgono già i turni che CiC risparmia con `browser_batch` (form: 6 turni contro 15). Serve soprattutto per sequenze di clic e attese.

### 2.5 Più browser collegati — M

- **Oggi:** un solo client (`this.client`). Una seconda `ext_init` sostituisce la prima («Replacing existing Chrome connection», `_setupChromeClient`), e le `ext_init` non-loopback sono rifiutate apposta (`ws-manager.js:292`).
- **Progetto:**
  - il server tiene una mappa di browser (id, etichetta, OS, versione): l'estensione aggiunge etichetta e OS a `ext_init`, modifica piccola;
  - `get_status` li elenca, un tool `select_browser` sceglie quello di sessione, e ogni tool accetta `browser`.
- **PC remoto (Chromebook + PC Windows):** l'estensione resta **solo localhost**, perché è la promessa privacy della scheda Store. Il collegamento fra macchine lo fa un tunnel (`ssh -R`) o il trasporto multi-PC di claude-master, dal localhost del PC remoto al server di questa macchina. Il token `ext_init` diventa obbligatorio in quel caso.

### 2.6 Workflow salvati — S

- **Oggi:** abbiamo il pezzo più forte, `session_record` in jsonl e `replay` deterministico a zero token con variabili, ma solo da CLI.
- **Manca:** un tool `workflows` (`list` / `run name vars`), così il modello lancia un flusso registrato in una chiamata; e la cartella dei flussi documentata (`~/.config/chrome-bridge/recordings/`).
- **Differenza da dire nel film:** gli «shortcuts» di CiC sono prompt salvati, che il modello riesegue pagando i turni; un replay nostro no.

### 2.7 Approvazione delle azioni — S, documentazione + setup

- **In Claude Code:** si pre-autorizza con regole `permissions.allow` in `settings.json`:
  - installazione con `install.sh`: `mcp__chrome-bridge__*` (tutto) o l'elenco dei tool di sola lettura;
  - installazione da plugin: `mcp__plugin_chrome-bridge_chrome-bridge__*`.
- **Proposta:**
  - una sezione README «Approve once», con i due set: sola lettura (derivato dalle annotazioni `readOnlyHint` che abbiamo già, `TOOL_ANNOTATIONS`) e tutto;
  - `/chrome-bridge:setup` (piano del 28/09) offre di scriverle, **chiedendo**: tocca la configurazione dell'utente.
- **Dopo, M:** allowlist per origine nel popup dell'estensione («su questi siti può scrivere»), l'equivalente dei permessi per sito di CiC.

### 2.8 `find` in linguaggio naturale — S

- **CiC:** `find` fa l'abbinamento fuori dal modello principale.
- **Da noi:** lo fa il modello, sulla lista compatta di `get_interactives`. Nel benchmark CiC ha usato `find` 6 volte in una run di form; noi ci arriviamo con i ref restituiti da `navigate`.
- **Proposta:** un `find` senza LLM (punteggio fuzzy su etichetta, ruolo, testo vicino, top 5 con ref). È comodo da cercare per nome (ToolSearch), ma non cambia le capacità. Priorità bassa.

### 2.9 Screenshot in un upload — S

- **Proposta:** `upload_file` accetta `from_screenshot: {tab_id, selector|region}` oltre a `path`. Un turno in meno, parità con `upload_image`.

## 3. Dove andiamo già oltre (solo affermazioni con fonte)

| Affermazione | Fonte |
|---|---|
| Form: 2,50× turni in meno e 1,92× costo in meno; pagina pesante: 1,17× turni e 2,31× costo, stesso modello, n=5 appaiato | `bench/RESULTS.md`, `docs/EFFICIENCY.md` (27/09, 1.23.2) |
| 60 tool | test `tool-counts.test.js`, `registerTools` con caps `all` |
| Simulazione di rete: mock, block, redirect, replay di risposte con errori forzati, HAR | `network_rules`, `session_record`, `monitor_network format:har` |
| Regressione visiva contro baseline, mockup o altro URL | `screenshot_diff` |
| Audit in una chiamata: a11y, tastiera, SEO, header di sicurezza, link rotti, vitals, CSS inutilizzato, risorse, cache CDN | `audit` (`AUDIT_KINDS`, `server/audit.js`) |
| Da quale regola CSS viene ogni stile | `get_css_styles` |
| Stack della console riportati ai sorgenti | `read_console sourcemap` (1.24.0, test `console-capture.test.js` + e2e) |
| Layout delle finestre, schede fra finestre | `window_layout`, `tile_windows`, `move_tab` |
| Handoff all'utente a metà compito (conferma, scelta, selezione di elementi) | `handoff` con `ask`, `pick_element`, `pick_max` |
| Richieste HTTP con i cookie dell'utente | `http_request` |
| Replay deterministico a zero token | `chrome-bridge replay` |
| Funziona su ChromeOS senza debugger | scheda Store, test sul campo; CiC qui si è dichiarato `isLocal:false` (falso negativo, memoria benchmark 27/09) |

Da non dire: «CiC non può leggere il DOM, il CSS calcolato o lo storage». Con `javascript_tool` può: la differenza è in turni e costo, non in capacità.

## 4. Ordine consigliato, permessi, versioni

| Versione | Contenuto | Estensione / Store | Permessi nuovi | Costo |
|---|---|---|---|---|
| 1.25.0 | `batch` (§2.4), `workflows` (§2.6), README «Approve once» + regole nel setup (§2.7), CDP diretto in launch mode per input fidato (§2.2 strada 3) | solo server, nessuna revisione | nessuno | S+S+S+S |
| 1.26.0 | coordinate sintetiche + `css_scale` (§2.3), `record` GIF a fotogrammi (§2.1 A), più browser (§2.5), upload da screenshot (§2.9) | sì, revisione normale | nessuno | S+S+M+S |
| 1.27.0 | video vero con `tabCapture` (§2.1 B) | sì | `tabCapture`, `offscreen` | M |
| decisione | input fidato nello Store (§2.2): stesso item o secondo item | sì, revisione severa | `debugger` (non opzionale) | M (+ gestione secondo item) |

Prima della 1.26.0 va fatta la prova diretta di `debugger` su ChromeOS (§2.2, 2 minuti di Franz): se la barra resta visibile o il click non arriva, la strada Store per l'input fidato si ferma lì.

## Decisioni per Franz

1. Input fidato: solo launch mode adesso, poi secondo item Store? Oppure stesso item, accettando che gli utenti attuali debbano riaccettare?
2. Registrazione: fotogrammi GIF subito (nessun permesso) e video vero dopo, oppure direttamente il video?
3. Più browser fra macchine: tunnel SSH o trasporto claude-master?
