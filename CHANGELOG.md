# Changelog

## 1.8.0 — 2026-07-29

Correttezza, sicurezza e onestà dei numeri, dopo un audit a tappeto
(`docs/ANALISI-2026-07-25.md`).

### Tool che mentivano al modello — corretti
- **`monitor_network` consegnava le richieste più VECCHIE** dicendo "most recent":
  a buffer pieno l'estensione scartava le richieste *nuove*. Ora è un ring buffer
  che scarta le vecchie, come già faceva `read_console`. Stesso difetto corretto
  in `watch_dom`.
- **`clear:true` distruggeva voci mai consegnate**: `read_console(clear:true, limit:50)`
  mostrava 50 messaggi e cancellava gli altri 950, e con `level:'error'` cancellava
  anche log/warn/info. Ora `clear` rimuove solo ciò che è stato restituito, e solo
  del level richiesto.
- **`read_console` non distingueva "pagina pulita" da "hook mai installato"**:
  rispondeva `count: 0` senza contesto e il modello concludeva che non c'erano
  errori. Ora restituisce `hooked` e una `note` esplicita, come già facevano
  `web_vitals` e `list_event_listeners`.
- **Il troncamento produceva JSON non parsabile**: il taglio per carattere spezzava
  la stringa a metà valore su ogni path `format=json`/`har`. Ora si riducono gli
  *elementi* (ricerca binaria sul prefisso più lungo che sta nel cap) e il payload
  dichiara `shown`/`total`/`truncated`.
- **Il messaggio di troncamento suggeriva `max_length` a 56 tool su 59 che non lo
  espongono**: il modello ritentava con un parametro inesistente. Ora il rimedio
  nomina il parametro reale del tool chiamante.
- **Race su `injectedTabs`**: l'hook di rete poteva finire sul documento morente e
  `monitor_network` restava a zero in silenzio fino alla navigazione successiva.
  Il tracking per-tab è stato eliminato in favore dell'always-inject idempotente
  già usato da `watch_dom`.
- **`session_record` poteva perdere uno step**: gli append erano fire-and-forget e
  un comando registrato poteva non essere sul disco quando `stop` tornava — uno
  step mancante rende un replay silenziosamente sbagliato. Le scritture sono ora
  serializzate e `stop` le attende.

### Sicurezza
- **Bind su `127.0.0.1` di default** (era `0.0.0.0` incondizionato). L'esposizione
  in rete è opt-in con `CHROME_BRIDGE_HOST`/`--host` per il port-forward Crostini.
  Con bind loopback una `ext_init` non-loopback viene rifiutata.
- **Il token è richiesto anche su `relay_init`**: proteggeva solo `ext_init`, quindi
  qualunque processo locale otteneva `execute_js` nella sessione autenticata del
  browser aggirando il segreto condiviso.
- `maxPayload` del WebSocket portato da 100 MiB a 32 MB.

### Robustezza
- **`stop()` non ritorna più mai**: un peer che completava l'handshake durante lo
  shutdown restava OPEN, `wss.close()` non richiamava e il processo MCP richiedeva
  SIGKILL. Ora si terminano tutti i socket del server (non i due Set tracciati),
  le nuove connessioni sono rifiutate durante lo shutdown, e un timer di sicurezza
  garantisce la chiusura.
- **Handler di shutdown registrati prima del launch** + `uncaughtException`: un
  segnale durante l'avvio lasciava Chromium e il profilo temporaneo orfani.
- **Relay: ack `relay_init_ok`**. Una porta occupata da un processo che non è
  chrome-bridge fallisce con un messaggio azionabile invece di far morire il primo
  comando dopo 30s. Se l'ack non arriva il peer viene sondato con un comando reale
  prima di dichiararlo estraneo: un primary chrome-bridge *precedente* a questa
  versione non conosce `relay_init_ok`, e durante un aggiornamento è il caso
  normale (verificato dal vivo contro un server 1.7.0 ancora attivo). L'ack porta
  anche `ext_connected`, così in relay mode `get_status` non dichiara più
  `connected: true` senza estensione collegata.
- **Version skew visibile**: `ext_init` porta la versione dell'estensione, esposta
  in `get_status` come `extension_version` e loggata quando divergono.
- **Timeout di trasporto ≥ timeout richiesto dal chiamante**: `wait_for --timeout 90000`
  moriva a 60s con un messaggio che il modello leggeva come "elemento non comparso".
- **`sessionTabId` invalidato e un ritentativo** quando l'utente chiude a mano la
  tab di sessione (prima ogni comando falliva fino al `navigate` successivo).
- Errori azionabili: "extension not connected" e i timeout ora nominano host, porta,
  mode, tab e la prossima azione da provare.

### Token e turni
- **`instructions` del server**: aggiunte due clausole imperative su `fill_form`
  (un turno invece di N) e su `extract_table`/`extract` al posto di `read_page`.
  Misurato: 3 call contro 9 sullo stesso form, a parità di byte.
- **`full_page_screenshot` era l'unico output fuori da ogni cap**: restituiva fino a
  10 immagini (~4 MB base64, ~27k token). Ora `max_segments` (default 3) e
  `segment_offset`, con il costo dichiarato nella descrizione.
- `read_console`, `monitor_network` e `watch_dom` applicano `limit` **in pagina**:
  il WebSocket non trasporta più 1000 voci per consegnarne 100.
- `screenshot_diff`: l'immagine di diff passa dal cap a 1568px come ogni altro
  screenshot, ed è omessa quando non c'è differenza.

### Nuove capability
- **`network_rules` sui response header** (`header_target: 'response'`): rimuovere
  `content-security-policy` e `x-frame-options`, iniettare CORS — tre dei blocchi
  più frequenti in sviluppo locale, a costo zero di nuovi permessi.
- `get_status` restituisce `host`, `extension_version`, `caps_active`,
  `caps_available`, `session_tab_id`: un agente che non trova un tool può ora
  scoprire che esiste ma è in un gruppo disattivato.

### CLI
- **Nessun troncamento su output JSON o in pipe**: la nota per umani rendeva il
  JSON non parsabile da `jq`.
- **Coercizione dei valori solo sulle chiavi numeriche/booleane**: `--text 00185`
  diventava `185` e `--code 42` diventava un numero invece di sorgente JS.

### Progetto
- `npm test` esegue gli unit (Chrome-free, ~22s, 109 test); `npm run test:e2e` per
  l'e2e con Chrome. Prima `npm test` pretendeva Chrome e chi clonava non otteneva
  un verde.
- `tools/measure-schema.mjs` (`npm run measure`): misura deterministica del costo
  di schema, fonte di verità unica. `test/unit/tool-counts.test.js` fallisce se i
  documenti divergono dal conteggio reale.
- Conteggio tool allineato: `package.json` diceva 56, il `Dockerfile` esponeva 30
  tool ai registry MCP contro i 59 dichiarati, `install.sh` registrava senza
  `--caps` (30 tool su 59 per chi installava).
- `install.sh`: preflight sulla porta e istruzioni corrette su ChromeOS/Crostini
  (dove l'estensione unpacked viene scartata a ogni reboot).
- `chrome-bridge-plan.md` archiviato in `docs/history/` con header **SUPERSEDED** e
  senza la direttiva che istruiva Claude a rieseguirlo: conteneva la versione a 8
  tool di `tools.js` e un agente poteva regredire il repo applicandola.
- L'hook `SessionStart` con `git pull` spostato in `.claude/settings.local.json`:
  in `settings.json` viaggiava con ogni clone e bloccava la sessione ai contributori.
- **`bench/RESULTS.md` riscritto**: la riga `heavy` pubblicava solo le run post-fix
  contro un arm `cic` non ri-eseguito. Ritirata, con la regola di inclusione ora
  scritta e `aggregate.py` che segnala run scartate e confronti non appaiati. Il
  risultato sul task `form` (2,75× turni, 2,28× costo) è confermato.

## 1.7.0 — pubblicata sul Chrome Web Store (listing: "Version 1.7.0")

### Popup ridisegnato
- Tema automatico dark/light (`prefers-color-scheme`), layout 320px.
- Warning "Allow user scripts" prominente con fix 1-click: bottone che apre direttamente la pagina dell'estensione in `chrome://extensions`.
- Card **Pagina corrente**: errori console e LCP/CLS (dai buffer dell'instrumentation, se attiva) + stack tecnologico euristico (React, Vue, Next.js, WordPress, Vite, … — global e meta note, best-effort).
- Telemetria di sessione: contatore tool call, ultimo tool con età, ultimi 5 errori con orario (persistita in `chrome.storage.session`, si azzera al riavvio del browser).
- Azioni: **Riconnetti** (chiude e riapre il WS con la config corrente), **Diagnostica** (copia un report JSON negli appunti per issue/supporto). Porta/token/instrument collassati dietro ⚙.

### Server
- Handshake `ext_init_ok { version }` in risposta a `ext_init`: il popup mostra versione extension e server affiancate.

## 1.6.0 (2026-07-14 — published on the Chrome Web Store)

- **Launch mode — headless & CI**: `node server/index.js --launch [--headless]` starts a dedicated Chromium with an ephemeral profile and the extension loaded unpacked, on an ephemeral WS port (no conflict with your everyday bridge). Isolated, reproducible sessions; combine with `replay` + `assert` for zero-token CI smoke tests. In launch mode `execute_js`/`wait_for(function)` run through a `new Function` fallback (no userScripts toggle in a fresh profile) — pages with a strict CSP need a `network_rules` header strip first. The Web Store package is unaffected: the fallback only activates in launch-mode copies.
- **Capability groups**: the MCP server registers the 30 core tools by default. Enable more with `--caps audits,visual,network,storage,dom,files` (or `CHROME_BRIDGE_CAPS`); `--caps all` restores the full 59.
- **Refs**: `get_interactives`, `navigate` and `find_text` return short refs (`n1`, `n2`…) that `click`/`type_text`/`hover` accept in place of a CSS selector.
- **Act-from-result**: `navigate` attaches a capped preview of the page's interactive elements; `find_text` attaches the ones nearest the first match. `click`/`fill_form` report a `page_changed` {url, title} delta when something changed.
- **Session tab default**: commands without `tab_id` target the tab last navigated/created by the session instead of the user-visible active tab — automation no longer collides with what you're doing in Chrome meanwhile.
- **`extract`**: pull repeated structured data (rows, cards, lists) in one call — item selector plus per-field relative selectors, parsed server-side. Deterministic, no LLM round-trips per item.
- **Record & replay**: `session_record` captures the session's commands as jsonl; `chrome-bridge replay --file flow.jsonl --vars '{"user":"jane"}'` re-runs the flow in a single process with `{{var}}` substitution — repeat runs cost zero model tokens.
- **`assert`**: polling assertions (element/text/count/url/title, substring or `/regex/`). Recorded flows replay as smoke tests: a failed assert marks the step ERR and sets exit code 1.
- **Response stubbing**: `network_rules action=stub` serves synthetic bodies (status, content-type) for matching requests via a local helper server — API mocking beyond block/redirect/headers. MCP-session only.
- Fixes: a11y audit now flags images with a *missing* `alt` as errors (was mis-detected as decorative); baseline cap race in `screenshot_diff`; diagnostic warning when the extension drops a message on a closed WebSocket.

## 1.5.0

- **Chrome Web Store ready** — zero `eval`: `execute_js` and `wait_for` (`condition=function`) run user code through the official `chrome.userScripts.execute()` API. One-time setup: enable **"Allow user scripts"** in `chrome://extensions` → Chrome Bridge → Details (Chrome 138+; on 135-137 enable Developer Mode). The popup warns when the toggle is off; every other tool works regardless.
- **Background captures — no more focus stealing**: `screenshot`, `full_page_screenshot`, `element_screenshot` and `screenshot_diff` activate the target tab *without* bringing the Chrome window to the foreground, then restore the previously active tab (and minimized state).
- **No more hanging captures**: on ChromeOS a fully occluded window can stop producing frames; captures now fail after 10s with a clear message instead of hanging forever.
- **`execute_js` runs in the MAIN world** by default (page variables and injected `<script>` tags behave as expected), with `USER_SCRIPT` world fallback. Page CSP no longer blocks it — code is injected, not `eval`'d.
- Requires **Chrome 135+** (was 111+).
