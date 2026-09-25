# Prompt audit — chrome-bridge, 2026-09-25

Eseguito con `/claude-api prompt-audit` (guida `shared/prompt-audit.md` della skill `claude-api`, aggiornata per Claude Opus 5.5).

**Assunzioni (Step 0).** Scope: la superficie di prompt del plugin, cioè ciò che arriva al modello come testo — `skills/chrome-bridge/SKILL.md` (frontmatter + corpo, 370 righe), le 60 `description` dei tool e le `.describe()` dei parametri in `server/tools.js`, il blocco `instructions` del server in `server/index.js:59-73`, `commands/observe.md` (generato dalla fonte claude-observe), `CLAUDE.md` di progetto (9 righe, generato). Modello bersaglio: Claude Opus 5.5 (indicato nella richiesta); il repo non chiama l'API direttamente, quindi il Gruppo 4 (config delle richieste) non si applica. Nessun marcatore di provider non-Anthropic. Provenienza: `git log` sui file; la skill e le descrizioni sono state scritte fra luglio e settembre 2026 già per la famiglia 4.6+/5, non per modelli ritirati.

**Metodo.** Grep dei segnali della guida su tutta la superficie (`MUST|NEVER|ALWAYS|CRITICAL|IMPORTANT`, `!!`, `try to|if possible`, `think step by step`, `If in doubt|Default to`, `Remember,|Again,|As stated`, `no longer|instead of`, nomi di modelli ritirati): **zero occorrenze** nelle descrizioni dei tool e nel blocco `instructions`; nella skill una sola (`instead of judging`, riga 158, non è una regola relativa a una versione precedente). Poi lettura per intero della skill e misura di ogni descrizione (caratteri, frasi).

## Riepilogo

| Gruppo | Riscontri | Applicati |
|---|---:|---:|
| 1 — testo datato (pressione, scaffold, iper-specificazione, fossili) | 0 | 0 |
| 2 — skill file | 2 (flag) | 0 |
| 3 — descrizioni dei tool | 3 (add) + 10 (flag, bassa) | 3 |
| 4 — config delle richieste | n/a | — |
| Fuori superficie: `CLAUDE.md` di progetto | 1 (alta, non applicato: file non tracciato, escluso per istruzione) | 0 |

La superficie è pulita rispetto ai pattern datati: nessuna enfasi in maiuscolo, nessun «think step by step», nessuna coreografia di aggiornamenti, nessuna proibizione senza motivo. I tre riscontri con azione sono tutti **sotto-descrizione** (Gruppo 3: il contratto del tool diceva meno di ciò che il tool restituisce), cioè il verso in cui la guida avverte che l'istinto «accorcia» sbaglia. Le proibizioni rimaste («never type credentials», «never read_page on a big table») hanno il motivo accanto e descrivono un guasto reale: restano.

## Riscontri

### 1. `server/tools.js:927` — `get_page_info` sotto-descritto (contratto ≠ comportamento) — **alta — add — applicato**

Evidenza: `'Get page metadata: meta tags, scripts, stylesheets, links, and forms'`.
Il tool restituisce anche `title`, `url`, `doctype`, `charset`, **`visibility`** e **`dev.server` / `dev.overlay`** (`extension/service-worker.js:1381-1417`). `visibility` è il campo su cui il blocco `instructions` del server e la skill fondano la regola «finestra coperta = niente screenshot», e `dev.overlay` è la difesa contro «pagina in errore letta come valida» (§15.1 di luglio): nessuno dei due era nel contratto. Pattern: Gruppo 3, «description must precisely match actual behavior». Sostituita con la descrizione completa (title, url, visibility con il significato di `hidden`, dev.server e dev.overlay con «read it before treating the page as valid»).

### 2. `server/tools.js:1564` — `upload_file` non dice che rifiuta — **media — add — applicato**

Evidenza: `'Set a file on input[type=file] from the server filesystem via DataTransfer (max 10MB).'`; il rifiuto di chiavi e credenziali (1.20.1) e il perimetro `--read-root` stavano solo nella `.describe()` di `path`. Pattern: Gruppo 3, «failure modes, what the tool does not return». Aggiunte le due clausole nella descrizione: cosa è rifiutato, e che la chiamata fallisce senza leggere nulla.

### 3. `server/tools.js:628` — `get_status` elenca quattro campi su tredici — **media — add — applicato**

Evidenza: `'Check bridge status: extension connection, server mode (primary/relay), port, version'`; il risultato porta anche `js_evaluation`, `write_root`, `read_root`, `caps_active`/`caps_available` (con il commento nel codice: «un agente che non trova accessibility_audit non aveva modo di scoprire che esiste ma è in un gruppo disattivato»), `session_tab_id`, `owned_tabs`, `uptime_sec`. Pattern: Gruppo 3. Descrizione riscritta con tutti i campi e il senso di ciascuno.

### 4. `server/tools.js` — dieci descrizioni sotto le tre frasi — **bassa — flag — non applicato**

`hover` (69 caratteri), `get_page_info` (risolto sopra), `query_dom` (104), `read_console` (95), `get_frames` (97), `set_geolocation` (96), `save_page` (91), `http_auth` (88), `watch_dom` (112), `drag_and_drop` (114), `dismiss_overlays` (109), `handle_dialogs` (126). La guida dice «3-4+ sentences minimum», ma la lista di controllo prevale: il contratto di questi tool sta nelle `.describe()` dei parametri (copertura 100%, Glama «Tool Definition Quality A») e il risultato è quello che il nome promette. Nessun caso di comportamento non dichiarato trovato. Da rivedere solo se la telemetria di claude-observe mostra chiamate sbagliate su uno di essi.

### 5. `skills/chrome-bridge/SKILL.md:1-4` — frontmatter `description` con enumerazione di frasi-trigger — **bassa — flag — non applicato**

Evidenza: la `description` elenca una dozzina di frasi d'esempio, anche in italiano. Pattern: Gruppo 2, «trigger-case enumeration». Ma la guida separa esplicitamente il testo di routing dal testo di comportamento: il frontmatter è routing e «may legitimately carry calibrated urgency, ideally tuned against a trigger eval». La suite `evals/` scritta oggi è quell'eval: la description si ritocca **dopo** il punteggio, non prima.

### 6. `skills/chrome-bridge/SKILL.md:14-28` («How to work») ⟷ `server/index.js:59-73` (`instructions`) — le stesse quattro regole in due posti — **bassa — flag — non applicato**

Evidenza: `fill_form` una volta invece di N `type_text`, `extract_table`/`extract` invece di `read_page`, `element_screenshot` invece di un altro screenshot, `assert`/`wait_for` invece di uno screenshot. Pattern: Gruppo 1c «padding / duplicati» — ma la lista di controllo, punto 8: «working redundancy is not cruft… propose deduplication only when the duplicates actually disagree». Non discordano, e servono due pubblici diversi (le `instructions` arrivano a ogni client MCP, la skill solo a Claude Code). Lasciato.

### 7. Proibizioni sulle credenziali dette tre volte — **bassa — flag — non applicato**

`SKILL.md:24` («never type credentials»), `handoff` (`tools.js:1843`, «Never type credentials yourself»), `SKILL.md` «Out of reach» («CAPTCHA, 2FA, passwords: the user does it in the browser»). Pattern: Gruppo 1e. Ogni occorrenza ha il motivo accanto e codifica un vincolo di sicurezza reale (punto 5 della lista di controllo). Le tre sedi sono tre funzioni: regola di lavoro, contratto del tool, confine di capacità. Lasciato.

### 8. `CLAUDE.md` (radice, non tracciato) — fotografia stantia caricata in ogni sessione — **alta — rewrite — non applicato (file escluso per istruzione)**

Evidenza: «Scheda generata da `.claude/inventario.py` il 2026-07-28», «ultimo commit 2026-07-24 · 142 commit», «Da sistemare: 39 file non committati (fotografia del 2026-07-28)». Oggi: 147+ commit, ultimo il 25/09, 17 file non tracciati. Pattern: Gruppo 2 «volatile specifics… nothing re-checks them». Il generatore `.claude/inventario.py` non esiste più nel repo (`.claude/` contiene solo `settings.local.json` e `skills/`). Proposta: rigenerare, oppure togliere le tre righe con date e conteggi e lasciare stack, remote e «Deploy: nessuno rilevato» (che è vero e utile). Il file è fra i 16 non tracciati che il master ha chiesto di lasciare fuori: nessuna modifica.

## Cosa non è stato toccato, e perché

- I passi numerati delle ricette (modulo→conferma→webmail→attesa; checkout→iframe carta→3DS→ordine): l'ordine conta, sono «fragile operations» (punto 3).
- Le frasi-trigger dentro le ricette («Triggers: …»): routing interno alla skill, stesso criterio del punto 5.
- «Answer with what does not match and what you could not check — never a bare "all good"» (`read_form`): proibizione con motivo, contro un guasto che si ripete (punto 5).
- Il blocco `instructions` del server: quattro regole di economia di turni, ciascuna con il costo accanto; il commento nel codice ne documenta la misura («un turno vale ~15-30 volte un KB»). Contesto, non pressione.
- Nessun esempio «gold» da rimuovere, nessuna sezione di formato da rimpiazzare con structured outputs (il server non costruisce richieste).

## Verifica (Step 7)

`node --check server/tools.js` ok; `npm test` dopo le modifiche (vedi riepilogo del ciclo). Le tre descrizioni cambiate sono contratto, non steering: non c'è un comportamento «prima/dopo» da misurare con un probe, c'è un contratto che ora coincide con il codice. Il costo di schema cresce di poco (tre descrizioni più lunghe): da rileggere con `npm run measure` al prossimo release.
