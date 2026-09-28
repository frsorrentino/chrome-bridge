# chrome-bridge — secondo giro: concorrenti e codice, in direzione efficienza (2026-09-28)

Stato: analisi e proposte, nessun codice. Chiesta da Franz alle 21:23. Obiettivo dichiarato: pareggiare le capacità altrui e offrire di più, più rapidamente e/o in modo più economico; **una sola estensione**, installazione più semplice.

Come è stata fatta:
- sei sub-agenti Sonnet in parallelo: tre sul web (concorrenti grandi, stessa tesi nostra, nuovi dal 11/09), tre sul codice (server, estensione, skill/schema/installazione);
- un parere indipendente di Codex (gpt-6-astra), che non ha visto i risultati degli altri. Antigravity (Gemini) non ha risposto: tre errori 503 («high demand»), vedi §6.

Legenda: **✔** = verificato da me in questa sessione (codice riletto alla riga, API di GitHub, fonte riaperta). **dichiarato** = affermazione del progetto, non misurata da noi. **da verificare** = trovato da un agente, non ancora ricontrollato.

## 0. In breve

1. **Il mercato si è spostato, e non verso i tool singoli.** I progetti con più adozione guidano il browser con una CLI più una skill, o con un solo tool che esegue codice:

   | Progetto | Stelle ✔ | Approccio |
   |---|---:|---|
   | agent-browser (Vercel) | 43.318 | CLI + skill |
   | OpenCLI | 29.676 | CLI, con un'estensione sul Chrome loggato |
   | ego-lite | 16.636 | chiamate a funzioni JS |
   | playwriter | 3.931 | un solo tool `execute` |

   chrome-bridge ne ha 5 (API di GitHub, 28/09).
2. **Il `debugger` nell'unica estensione è la norma, non un'eccezione.** Lo usano Claude in Chrome, l'estensione di Playwright MCP e playwriter, che si installa con un clic sull'icona (manifest letto ✔). Noi siamo l'eccezione.
3. **Nel nostro codice ci sono tre classi di problemi:**
   - risultati sbagliati senza avviso: 8 verificati, 4 da verificare (§2.1);
   - giri e attese evitabili fra azione e osservazione (§2.2);
   - un costo fisso per sessione più alto del necessario: schema, skill, avvio (§2.3).
4. **Le leve di efficienza più forti** sono sei, in ordine:
   1. azione e osservazione in un solo comando, con i riferimenti nuovi nella risposta;
   2. «code mode», cioè più azioni in una chiamata con cicli e condizioni;
   3. skill corta con trigger stretto;
   4. gruppi di tool di base per default, con attivazione a runtime;
   5. «salta se invariato» per screenshot ed elenchi;
   6. osservazioni incrementali con cursore.

   Dettaglio in §3.

## 1. Concorrenti: cosa è cambiato (fonti lette il 28/09)

### 1.1 I grandi

| | Stato al 28/09 | Novità dal controllo precedente | Meccanismi di efficienza |
|---|---|---|---|
| **Claude in Chrome** | Claude Code 2.1.283 (25/09) | 2.1.282: `allowClaudeInChromeWithManagedMcp`; 2.1.280: finestra dedicata in VS Code (`/chrome`). Esportazione delle trascrizioni via Compliance API (18/09, **da verificare**) | classificatore di auto-approvazione; nei documenti: «enabling Chrome by default increases context usage since browser tools are always loaded». Installazione in 7 passi |
| **chrome-devtools-mcp** | 1.10.1 (23/09) ✔ npm | 1.10.0: `get_css_styles` via CDP (PR #2612 unita), parser a blocchi per i trace grandi, file di configurazione | `--slim` (3 tool), gruppi per categoria, limiti di dimensione degli screenshot. Un passo con profilo isolato; il Chrome reale richiede debug remoto + `--autoConnect` |
| **Playwright MCP** | 0.0.82 (18/09) ✔ npm, nessuna release dopo | — | `--image-responses omit`, `--snapshot-mode none`, `browser_fill_form`. Modalità `--extension` in 4 passi, con permesso `debugger` |

Fonti: https://code.claude.com/docs/en/chrome, https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md, https://github.com/ChromeDevTools/chrome-devtools-mcp/releases/tag/chrome-devtools-mcp-v1.10.1, https://registry.npmjs.org/chrome-devtools-mcp, https://registry.npmjs.org/@playwright/mcp, https://github.com/microsoft/playwright-mcp.

### 1.2 Nuovi, o mai monitorati prima (stelle e date ✔ via API di GitHub, 28/09)

| Progetto | Stelle | Creato / ultimo push | Tesi | Cosa ci insegna |
|---|---:|---|---|---|
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | 43.318 | 2026-01-11 / 09-28 | CLI su CDP con skill; Chrome for Testing per default, `--auto-connect` al Chrome reale | `batch`, `diff snapshot`, `screenshot --if-changed` («skip unchanged images to save tokens»), `read` senza avviare Chrome, profilo MCP `core` di default, profiler (README ✔) |
| [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI) | 29.676 | 03-14 / 09-24 | «make any website a CLI», usa il browser loggato con un'estensione ponte | i flussi per sito diventano comandi deterministici: il modello non ripete l'esplorazione |
| [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite) | 16.636 | 04-16 / 09-23 | browser separato per agenti, spazi umano/agente | dichiarato: «up to 2.5x faster» di agent-browser, con chiamate a funzioni JS invece di un comando per passo |
| [remorses/playwriter](https://github.com/remorses/playwriter) | 3.931 | 2025-11-13 / 09-24 | **un'estensione** (permessi ✔: `debugger`, `tabCapture`, `offscreen`, `tabGroups`…) + CLI + MCP sul Chrome dell'utente | **un solo tool `execute`** con l'API Playwright completa e stato persistente; video con `tabCapture` (dichiarato «100x more efficient» di Playwright); installazione: Store, clic sull'icona, CLI, skill |
| [agentrhq/webcmd](https://github.com/agentrhq/webcmd) | 2.609 | 07-02 / 09-25 | browser che impara la mappa del sito | dichiarato: «up to 90%» di token in meno sui siti già visti |
| [unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse) | 766 | 01-27 / 09-28 | impara le API HTTP del sito e le richiama senza browser | dichiarato: 100× più veloce dopo l'apprendimento. Noi abbiamo `http_request` + `session_record`, non il passo «impara» |
| TypeSafe «Jev» | — | uscito il 15/09 | modello dedicato a scegliere la prossima azione | dichiarato: 280-740 ms per decisione (beam.ai, 15/09). È un altro livello (il modello), da osservare |
| [ItaiZeilig/pawbrowse](https://github.com/ItaiZeilig/pawbrowse), [Mehmoodqureshi/chrome-mcp](https://github.com/Mehmoodqureshi/chrome-mcp) | 14, 6 | 09-20, 06-11 / 09-27, 09-26 | la nostra stessa architettura | niente di nuovo sull'efficienza |

Scartati dopo il controllo (una riga ciascuno nel report dell'agente): browser-tools-mcp (fermo dal 12/08), OpenAI Atlas (dismesso il 09/08), Cloudflare Browser Run (browser in cloud), Perplexity Comet, Gemini in Chrome / WebMCP (origin trial), un gruppo di repository spam, strumenti verticali (design-extract, sorify, angular-devtools…).

### 1.3 Stessa tesi nostra (stelle e date ✔ via API di GitHub, 28/09, salvo dove indicato)

| Progetto | Stato | Da copiare (efficienza) |
|---|---|---|
| [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) | 7.718★, `bsk` 0.3.1 (23/09), push 28/09 | **budget di token della skill**: da 4.206 a 2.959 token (−29,6%) spostando l'elenco dei comandi in un `bsk help` letto su richiesta (PR #254, unita il 15/09, riaperta dall'agente). Ha anche un collegamento remoto fra macchine (WSS) |
| [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) | **12.452★**, fermo dal 06/01 | la nostra stessa tesi con molta adozione e nessuno sviluppo: gli utenti di quel progetto sono il pubblico naturale di chrome-bridge |
| [browsermcp/mcp](https://github.com/browsermcp/mcp) | 7.143★, fermo dal 24/04/2025 | idem |
| [dondai44423/bladebro](https://github.com/dondai44423/bladebro) | 281★, v4.0.1 (27/09) | **5 tool «a verbi»** al posto di un tool per operazione: dichiarati ~1.900 token contro 8.000-13.700; `run` con if/else/while su un elenco di passi in una chiamata. Il browser reale solo con `rb on` |
| [JuliusBrussee/caveman-browse](https://github.com/JuliusBrussee/caveman-browse) | 36★ (agente) | 4 tool = **297 token misurati** contro 3.422 di Playwright MCP e 4.507 di DevTools MCP (14/08) |
| [shaun0927/openchrome](https://github.com/shaun0927/openchrome) | 237★, 1.15.0 (24/09), 122 tool | playbook YAML **validati offline**, senza browser, prima di spendere un turno; poi girano a zero turni. Nessuna estensione: CDP esterno, e Chrome 144+ chiede un'approvazione manuale a ogni connessione |
| [Agent360dk/browser-mcp](https://github.com/Agent360dk/browser-mcp) | 48★, v1.30.1 (27/09) | il 18/09 ha corretto **9 tool che dichiaravano successo sull'ack di Chrome** senza verificare l'effetto: lo stesso difetto di classe che abbiamo corretto noi nella 1.23.4 e che resta in §2.1 |
| iFurySt/open-browser-use | 346★ (agente), fermo dal 08/09 | `run_action_plan`: passi eterogenei (navigazione, click, CDP, attese) in una chiamata |
| browser-use | 116.616★ del repository (agente) | niente menu di tool: CDP grezzo + harness Python modificabile, un compito a più passi = uno script. «6x fewer tokens» è un aneddoto del produttore |
| OpenAI Codex for Chrome | 6M utenti sullo Store (agente, non ricontrollato) | nessun benchmark pubblicato; una issue aperta lo dice «laggy and token-heavy». Usa `debugger` |
| [browserbase/stagehand](https://github.com/browserbase/stagehand) | 25.439★, push 28/09 | SDK `act`/`extract` per Claude Code e Codex, browser in cloud |

Quasi tutti quelli con un'estensione usano `debugger`: BrowserSkill, Agent360, open-browser-use, Codex for Chrome, playwriter. Fa eccezione hanelalo/browser-bridge (53★, fermo dal 30/08), che come noi ne fa a meno.

### 1.4 Tre lezioni

1. **Più azioni per chiamata, con logica.** playwriter con `execute`, ego-lite con le funzioni JS e agent-browser con `batch` riducono i turni facendo girare più passi senza il modello in mezzo. È la stessa tesi dell'articolo Anthropic «Code execution with MCP: Building more efficient agents», che parla di contesto ridotto «up to 98.7%» (https://www.anthropic.com/engineering/code-execution-with-mcp, 2025, riaperto ✔). Noi abbiamo la CLI a zero token e `replay`, ma nessun «code mode» dentro MCP.
2. **Non rimandare ciò che non è cambiato.** agent-browser salta gli screenshot uguali e fa diff degli snapshot. Noi abbiamo `page_fingerprint` dalla 1.17 ma non lo usiamo per saltare.
3. **`debugger` in una sola estensione, acceso a richiesta.** È la scelta di chi va più forte sulla capacità, e non allunga l'installazione (playwriter: un clic). Il costo reale per noi è la riaccettazione una tantum degli utenti attuali, più la barra «sta eseguendo il debug» mentre è agganciato.

## 2. Il nostro codice: cosa si può fare meglio

### 2.1 Risultati sbagliati senza avviso

Sono il danno peggiore per un prodotto che si presenta come strumento di debug: l'agente conclude il falso e spende turni a rincorrerlo.

| # | Dove | Cosa succede | Stato |
|---|---|---|---|
| 1 | `server/tools.js:206`, `extension/service-worker.js:4150` | `extract_table` con `where`: l'estensione legge solo le prime `maxRows` righe, e il server nasconde il `truncated` di monte (`Boolean(data.truncated && !hasWhere)`). Esito possibile: `match_count: 0, truncated: false` anche se la riga cercata esiste oltre il limite | ✔ (Codex) |
| 2 | `extension/service-worker.js:1697`, `server/tools.js:1142` | `read_console clear:true` cancella in pagina tutte le voci restituite, poi il server taglia il testo a 20.000 caratteri: le voci oltre il taglio sono perse senza essere state mostrate. Stessa sequenza per la rete (`service-worker.js:1828`, `tools.js:1184`, **da verificare**) | ✔ console (Codex) |
| 3 | `server/tools.js:546-570` | il registro dei riferimenti è per scheda e selettore, senza frame: lo stesso `#save` in due frame riceve lo stesso `n1`, e un click con il solo `ref` va nel frame principale | ✔ (Codex) |
| 4 | `extension/service-worker.js:819`, `:632` | `screenshot` su finestra nascosta: restituisce un fotogramma vecchio. `pageHidden()` esiste ma lo usano solo `move_tab` e il percorso d'errore; `element_screenshot` invece fallisce correttamente | ✔ (osservato dal vivo il 28/09) |
| 5 | `extension/lib/css-cascade.js:293`, `:330-334` | `get_css_styles` su `background: var(--x)`: valore dichiarato `""` per le proprietà singole (la specifica CSSOM fa così), senza segnalarlo | ✔ (osservato dal vivo) |
| 6 | `server/formatters.js:15` | `monitor_network` con sorgente `browser`: durata «nullms» | ✔ |
| 7 | `extension/console-capture.js:43-53` | errori di caricamento delle risorse (img/script 404): riga «Uncaught  at ?:0:0» senza dire quale risorsa | ✔ (agente, riga riletta) |
| 8 | `extension/service-worker.js:1822-1839` | `monitor_network` sorgente `page`: il gancio si riarma a ogni chiamata, quindi **le richieste fatte durante il caricamento sfuggono**. Dal vivo: dopo una ricarica `total=0`, mentre `/api/cart` era partita al caricamento | ✔ (osservato dal vivo) |
| 9 | `extension/service-worker.js:2043`, `:2096` | `fill_form`: campi disabilitati o readonly riportati come successo; submit cliccato anche con campi falliti; submit mancante ignorato | **da verificare** (Codex) |
| 10 | `extension/service-worker.js:3580`, `:1732`, `:1756` | `wait_for network_idle`: il gancio parte con `inflight=0` e non vede le richieste già avviate dall'azione precedente, quindi può dichiarare quiete troppo presto | **da verificare** (Codex) |
| 11 | `server/tools.js:907`, `extension/service-worker.js:3493` | `wait_after: navigation` si arma dopo il click: una navigazione veloce già conclusa dà «No navigation started» dopo 5 s | **da verificare** (Codex) |
| 12 | `extension/lib/capture-pacing.js:10`, `service-worker.js:669` | due catture concorrenti prenotano lo stesso slot di 520 ms, e l'attivazione della scheda non ha un lock per finestra: rischio di screenshot della scheda sbagliata | **da verificare** (Codex) |

### 2.2 Giri e attese fra azione e osservazione

- **Click: 3 giri e 150 ms fissi.** `server/tools.js:904-911`: impronta prima, click, 150 ms di attesa fissa, impronta dopo. Mediana 197 ms contro i 18 ms di `type_text` (`docs/PERFORMANCE.md`): l'attesa fissa pesa circa il 76%. E la risposta non contiene i riferimenti agli elementi comparsi: se il click apre un menu serve un `get_interactives` in più. `interactivesPreview()` esiste (`tools.js:672`) ma lo usa solo `navigate` (`tools.js:770`) ✔.
- **Attese fisse prima degli screenshot:** 200 ms (`service-worker.js:824`) e 300 ms (`:2791`, `:3750`). Un doppio `requestAnimationFrame` basta ad aspettare un fotogramma disegnato.
- **Librerie reiniettate a ogni chiamata:** `lib/css-cascade.js` (19 KB, `service-worker.js:1590`) e `lib/element-label.js` (`:4687`), senza guardia per documento. Proprio `get_interactives` è il tool che le istruzioni del server dicono di chiamare spesso.
- **Attese in serie che potrebbero essere parallele:**
  - `network_rules record`: fino a 50 URL uno alla volta (`tools.js:1772-1777`), mentre il pool concorrente esiste già (`redirects.js:35-54`, `link-checker.js:45-55`);
  - `session_fixture` imposta una chiave e un cookie alla volta (`tools.js:2386-2406`);
  - `fill_form` fa due letture iniziali in serie (`tools.js:1359-1360`);
  - `evidence` fa 6 letture in serie (`cli.js:320-332`), più 2 s fissi dopo che la rete è già quieta (`cli.js:318-319`).
- **Attese al posto degli eventi:**
  - `watch` con ricarica aspetta 3 s fissi (`service-worker.js:2484`), mentre `waitForComplete()` esiste (`:1211`);
  - `manage_downloads` fa polling ogni 250 ms invece di usare `downloads.onChanged` (`:4422-4472`).
- **Primo collegamento:**
  - l'estensione riprova con attese fino a 30 s (`service-worker.js:84-85`, `:257`), mentre il server aspetta un'estensione non collegata solo 10 s (`ws-manager.js:44`) ✔: il primo comando di una sessione nuova può fallire;
  - se Chrome ha addormentato il service worker, lo sveglia solo l'allarme ogni 30 s (`:114`), che è il minimo di Chrome.

### 2.3 Costo fisso per sessione

- **Schema** (misurato oggi con `node tools/measure-schema.mjs`):
  - gruppi di base: 39 tool, 39.977 B, ≈10,0k token;
  - tutti: 60 tool, 61.910 B, ≈15,5k token;
  - `docs/EFFICIENCY.md:48` dice ancora «34 core… ≈9.1k… 63… ≈16.3k» ✔, e il test anti-deriva non controlla quel file (`test/unit/tool-counts.test.js:37`) ✔;
  - il plugin forza tutti i gruppi (`mcp.json:14`): circa +5,5k token per sessione nei client che non rinviano il caricamento dei tool.
- **Skill:**
  - un solo file di 381 righe e 23,4 KB, dove il nucleo «How to work» occupa ~36 righe e il resto sono 30 ricette;
  - la frase d'innesco è generica («test, debug, audit, compare or automate something in a browser», `SKILL.md:3`) ✔. Misurato il 27/09: scatta in 3 run su 5 sul modulo e costa 2 turni in più (da 4 a 6; `bench/RESULTS.md:75-80`).
- **Avvio:**
  - il plugin lancia `npx -y chrome-bridge-mcp@1.24.0` a ogni sessione (`mcp.json:6-11`, `plugin.json:24-36`), mentre `install.sh` usa un percorso locale;
  - i due manifest del plugin non coincidono: solo `mcp.json` fissa la cache npm, solo `plugin.json` imposta `CHROME_BRIDGE_OBSERVE`.
- **Doppia registrazione:** plugin e `install.sh` insieme registrano lo stesso server due volte, cioè +15,5k token, e nessuno lo rileva. Il matcher degli hook copre entrambi i nomi (`hooks/hooks.json:5`); oggi c'è solo la frase «Pick one path» nel README.
- **Costo sulla navigazione normale:**
  - la strumentazione gira su **ogni pagina** a `document_start` (`service-worker.js:44-60`);
  - `page-instrumentation.js:71-72` sostituisce `EventTarget.prototype.addEventListener` globalmente, solo per servire `list_event_listeners`, un tool di diagnosi raro.

## 3. Proposte — secondo giro

In ordine di valore rispetto al costo. «1.25.0» vuol dire senza revisione Store, se tocca solo il server.

### A. Subito (S)

1. **Chiudere i risultati sbagliati verificati** di §2.1: numeri 1, 2, 3, 6 lato server; 4, 5, 7, 8 lato estensione. Poi un test negativo per tool (selettore assente, finestra nascosta, frame, troncamento), perché questa classe non si ripresenti.
2. **Skill in due livelli:**
   - un nucleo di ~80 righe con trigger stretto sulle ricette vere;
   - le ricette in file separati, letti su richiesta.

   Atteso: circa −75% di token per caricamento e −2 turni dove oggi scatta a vuoto. Va rimisurato con lo stesso benchmark.
3. **Gruppi di base per default anche nel plugin**, e un tool per attivare un gruppo a runtime (esiste già `caps_available` in `get_status`). Atteso −5,5k token per sessione nei client senza caricamento rinviato.
4. **Riferimenti nuovi dopo ogni azione:** `click`, `fill_form` e `press_key` chiamano `interactivesPreview()` quando `page_changed` vede elementi aperti o comparsi. Atteso −1 turno ogni volta che un'azione apre un'interfaccia.
5. **Parallelo dove i giri sono indipendenti** (`network_rules record`, `session_fixture`, `fill_form`, `evidence`) e via i 2 s fissi di `evidence`. Atteso, stima: da ~10 s a ~2 s su un `record` di 50 URL.
6. **Numeri veri in `EFFICIENCY.md`** e il file dentro il test anti-deriva.

### B. Il salto (M)

7. **Un comando «act» nell'estensione:** osserva, agisce, attende in modo adattivo (quiete del DOM con MutationObserver, attese armate *prima* dell'azione) e osserva di nuovo, tutto in un solo messaggio. Restituisce esito, delta e riferimenti nuovi. L'idea è di Codex (`tools.js:904`, `:1359`).
   - Toglie giri, i 150 ms fissi e la corsa sulla navigazione (§2.1 n. 11).
   - È il punto unico dove innestare in seguito l'input fidato.
8. **«Code mode» in MCP:** un tool `run` che esegue sul server uno script JS contro la nostra API (`click`, `fill`, `wait`, `extract`…), con cicli e condizioni, e restituisce solo il risultato.
   - Precedenti: playwriter `execute`, agent-browser `batch`, l'articolo Anthropic sul code mode.
   - Sicurezza: contesto `vm` con la sola API chrome-bridge, niente fs né rete, e `--no-js` lo spegne.
   - Nel frattempo, a costo zero, la skill può indicare la CLI per le sequenze note: uno script di comandi `chrome-bridge` gira senza il modello fra un passo e l'altro.
9. **Salta se invariato:** `screenshot` con `if_changed` (confronto con `page_fingerprint`) e `get_interactives` con `since`, che restituisce solo le differenze dall'ultima lista.
10. **Osservazioni incrementali con cursore** (idea di Codex): console e rete lette per cursore, senza cancellazioni distruttive; riferimenti legati a frame e documento, invalidati alla navigazione.
11. **Strumentazione solo dove si indaga.** Accesa per scheda o per origine quando l'agente la usa: registrazione della rete dall'apertura della pagina lì, niente sulle altre pagine. Il wrapper di `addEventListener` si separa e diventa opzionale.
12. **Primo collegamento senza fallimenti:**
    - attesa massima fra i tentativi a 5 s finché il service worker è vivo;
    - reset dei tentativi quando cambia la configurazione;
    - risveglio anche su `tabs.onActivated`;
    - `connectWait` del server allineato a questi tempi.

### C. Capacità (decisione di Franz)

13. **`debugger` nell'unica estensione, agganciato solo a richiesta** (input fidato come ripiego, coordinate, video, trace, CSS esatto) e staccato subito dopo. Rispetta «una sola estensione» ed è la scelta dei concorrenti più capaci. Costo:
    - riaccettazione una tantum degli utenti attuali all'aggiornamento;
    - barra «sta eseguendo il debug» durante l'uso;
    - revisione Store più severa.

    Alternativa: solo nel browser lanciato da noi.
14. **«Impara e riesegui» sul sito:** trasformare un flusso registrato con `session_record` in chiamate `http_request` dove la pagina è solo un client di un'API (come fa unbrowse). Da valutare dopo.

### B2. Dal report «stessa tesi»

16. **Un profilo «slim» a verbi**, accanto ai 60 tool: 6-8 tool generali (`browse`, `look`, `act`, `inspect`, `check`, `run`…) che smistano verso le funzioni esistenti. È l'equivalente del `--slim` di DevTools MCP e dei 5 tool di bladebro. I 60 restano per chi li vuole. Va misurato con `tools/measure-schema.mjs` e con il benchmark: meno schema non deve voler dire più turni.
17. **Validare i flussi registrati senza browser** (`chrome-bridge replay --check`): uno schema e i riferimenti controllati prima di eseguire, come i playbook di openchrome. S.
18. **Controllo di consegna su tutti i tool che scrivono**, sul modello di Agent360 e della nostra 1.23.4: dopo l'azione si rilegge l'effetto, mai solo l'ack. Entra nella suite negativa della proposta 1.

### D. Misura prima e dopo

15. **Benchmark esteso:** 5 compiti (modulo, pagina pesante, scena di debug del 28/09, app a più passaggi, controllo visivo) contro Claude in Chrome, agent-browser e playwriter, n=5 appaiato, pubblicato. Serve anche alla distribuzione (§4). Costo in quota alto: dopo il reset.

## 4. Onestà sul mercato

Con 5 stelle contro 43.318 (agent-browser), 29.676 (OpenCLI), 16.636 (ego-lite) e 3.931 (playwriter), la differenza non la fa una funzione in più. La fanno la distribuzione e un confronto pubblico misurato.

- agent-browser si installa come skill da skills.sh (badge nel README ✔).
- playwriter si presenta con tabelle di confronto contro tutti, compresi Claude in Chrome e Antigravity.

Le proposte A e B danno i numeri da mostrare; la §3.D li rende pubblici.

## 5. Fonti principali

- API di GitHub, 28/09: `repos/{vercel-labs/agent-browser, jackwener/OpenCLI, citrolabs/ego-lite, remorses/playwriter, agentrhq/webcmd, unbrowse-ai/unbrowse, ItaiZeilig/pawbrowse, Mehmoodqureshi/chrome-mcp, frsorrentino/chrome-bridge}`.
- README: https://github.com/vercel-labs/agent-browser e https://github.com/remorses/playwriter (letti ✔). Manifest di playwriter: `extension/manifest.json` 0.0.151 ✔.
- https://www.anthropic.com/engineering/code-execution-with-mcp ✔.
- Report degli agenti e il parere di Codex: nello scratchpad della sessione, non nel repository.
- Misure del codice: `node tools/measure-schema.mjs` (28/09), `docs/PERFORMANCE.md` (11/09), `bench/RESULTS.md` (27/09).

## 6. Da completare

- Report «stessa tesi»: integrato in §1.3 e §3.B2.
- Parere di Antigravity / Gemini: **non disponibile**. Cinque tentativi fra le 21:43 e le 21:56:
  - tre con Antigravity su `gemini-3.7-flash` e `gemini-3.6-flash`: «Error 503 … high demand»;
  - uno con Antigravity su `gemini-3.1-pro`: «Error 429 … exceeded your current quota», perché il piano gratuito non ha quota per il Pro;
  - uno via API su `gemini-3.8-flash`: di nuovo 503.

  Avvertenza per chi ci riprova: Antigravity gira in una cartella vuota e non vede il repository; va passato un estratto del codice con i numeri di riga (preparato: 57 KB, 20 blocchi). La quota gratuita si azzera a mezzanotte di Los Angeles, le 09:00 italiane. Nessun contenuto di Gemini è usato in questo documento.
