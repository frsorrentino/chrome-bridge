# chrome-bridge — verifica concorrenti 2026-09-11 (dal 2026-09-01)

**Versione nostra:** 1.16.1 + 1 commit (`595f1d4`, `window_layout` dalla CLI). npm 1.16.1 live, registry MCP 1.16.1 `latest` (il 09-01 era fermo a 1.10.1: risolto).
**Precedente:** `docs/analisi-2026-09-01.md`. Qui si dà per letto e si dice solo cosa è cambiato in dieci giorni e cosa è comparso di nuovo.
**Metodo (tutto consultato il 2026-09-11):** GitHub API su 12 repo noti (commit dal 2026-09-01, release, stelle); `npm view … time` su 12 pacchetti; registry MCP ufficiale (`search=browser|chrome|extension`, 43 voci uniche); ricerca GitHub (`mcp browser` creati dal 2026-07-01, `mcp chrome extension` dal 2026-06-01, `browser mcp` con push dal 2026-09-01 e ≥30 stelle); clone shallow di 21 repo con digest automatico (README, `manifest.json`, nomi dei tool); lettura diretta dei diff `chrome-devtools-mcp` 1.8.0→main (48 file, +4 066), dei 49 commit di Agent360, della PR Playwright #42359 e del README di Playwright MCP; docs `code.claude.com/docs/en/chrome`, articolo supporto 12012173, changelog Claude Code 2.1.258→2.1.268; docs Codex (`learn.chatgpt.com/docs/chrome-extension`); web search. Dove un numero è di terzi è scritto.

---

## A. Concorrenti noti: cosa è cambiato

### A.0 Attività dal 2026-09-01

| Repo | Stelle (09-01 → oggi) | Commit dal 09-01 | Release | Verdetto |
|---|---:|---:|---|---|
| ChromeDevTools/chrome-devtools-mcp | 50,4k → 51,6k | **56** | 1.9.0 (09-08), 1.10.0 in PR | il più attivo, direzione "DevTools per agenti" + sicurezza |
| Agent360dk/browser-mcp | 37 → 40 | **49** | 1.29.0 (09-07) | il più vicino a noi, ha pubblicato i propri difetti misurati |
| microsoft/playwright-mcp (+ playwright-cli) | 36,7k → 37,0k | 3 (+3) | 0.0.80 (09-01), cli 0.1.19 | due tool nuovi che ci riguardano |
| anthropics/claude-code (Claude in Chrome) | 144,7k | 20 | 2.1.258 → 2.1.268 (9 release) | GA, auto-approvazione, Linux documentato |
| LinVireo/browsertap-mcp | 2 | 5 | nessuna (0.4.12 del 08-23) | hardening, privacy |
| ofershap/real-browser-mcp | 49 → 50 | 1 (dipendenze) | nessuna | fermo; badge Agent Plugins 1.0 |
| browser-use/browser-use | 112k → 114k | 100 | — | agente, non bridge |
| hangwin/mcp-chrome | 12,4k | 0 (dal 2026-01-06) | — | morto, 229 issue aperte |
| browsermcp/mcp | 7,1k | 0 (dal 2025-04-24) | — | morto |
| browserbase/mcp-server-browserbase | 3,4k | 0 (dal 07-20) | — | fermo |

npm dal 09-01: `@playwright/mcp` 0.0.80, `chrome-devtools-mcp` 1.9.0, `@agent360/browser-mcp` 1.29.0, `@playwright/cli` 0.1.19, `chrome-bridge-mcp` 1.16.0 e 1.16.1. Nessun publish di `@browsermcp/mcp`, `@browserbasehq/mcp-server-browserbase`, `real-browser-mcp`, `crawlio-browser`.

### A.1 Claude in Chrome (Anthropic)

Fonti: `code.claude.com/docs/en/chrome` (letto oggi), articolo supporto 12012173, changelog 2.1.258–2.1.268, definizioni dei tool caricate in questa sessione.

- **GA dal 2026-08-26** per i piani a pagamento (nel documento del 09-01 non era detto).
- **Modalità "automatically approve"**: un classificatore valuta ogni azione rispetto alla richiesta originale e approva da solo quelle giudicate sicure, "same mechanism as auto mode in Claude Code"; disattivabile. In plan mode i tool di sola lettura (`read_page`, `get_page_text`, `find`, console, rete, screenshot) girano senza prompt; `browser_batch` senza prompt solo se ogni azione è read-only.
- **Piattaforme: la nostra frase "Windows e macOS soltanto" è stantia.** La pagina docs di Claude Code elenca il file native messaging anche per **Linux** (`~/.config/google-chrome/NativeMessagingHosts/…`, e Edge) e dice che l'estensione viene rilevata in Brave, Arc, Vivaldi, Opera. Restano esclusi **WSL** (esplicito) e **ChromeOS** (non nominato; il native host va letto dal Chrome host, che non vede il container Crostini). L'articolo di supporto dice ancora "Google Chrome only", contraddicendo la pagina docs: due fonti, due versioni; nel nostro README va scritto "Linux desktop documentato da Anthropic, ChromeOS e WSL no".
- **Permessi dichiarati (articolo supporto): 15**, tra cui `debugger` ("clicking buttons, typing text, and taking screenshots"), `history` no, `webNavigation`, `notifications`, `system.display`, `declarativeNetRequestWithHostAccess`, `nativeMessaging`, `downloads`, `unlimitedStorage`.
- **Side panel come sessione Cowork** (Max/Team/Pro in rollout): conversazioni, skill e connettori passano tra browser, web, desktop, mobile; task programmati (giornalieri/settimanali/mensili/annuali); scorciatoie; "workflow recording" solo nel side panel classico; 1Password beta macOS; il gruppo di schede della sessione si chiude su `/clear` con regole precise.
- **Changelog che ci tocca**: 2.1.268 "long page reads now stay inline instead of being saved to a file and read back"; `read_page` oggi ha `max_chars` (default 50 000), `depth`, `ref_id`, `filter`; 2.1.260 impostazione admin dell'organizzazione che spegne `--chrome`; 2.1.261 fix `file_upload` in Cowork.
- **Deferral MCP, ancora più stabile**: 2.1.267 "mid-session MCP and plugin tools … supported models now receive them as deferred definitions", lista tool byte-stabile, `/model` non rispedisce le definizioni; 2.1.260 `/cost` mostra la causa dei cache miss. Conseguenza per noi: su Claude Code il costo dello schema è sempre meno un argomento; resta pieno su Cursor, Codex, Windsurf.

### A.2 Playwright MCP 0.0.80 e playwright-cli 0.1.19 (2026-09-01)

Fonti: release notes, PR microsoft/playwright #42359 (merge 2026-08-24, +446 −14, 15 file), README `microsoft/playwright-mcp` letto oggi, release Playwright 1.63.0 (2026-09-04).

- **`browser_start_recording` / `browser_stop_recording`** (cap `devtools`, CLI `recording-start/stop`): registra ciò che **l'utente** fa nel browser e lo restituisce come codice Playwright. Implementazione: due tool sopra il recorder del codegen (`_enableRecorder({mode:'recording', recorderMode:'api'})` con sink `actionAdded/signalAdded`), uscita = righe di codice nel linguaggio configurato. Funziona anche con browser lanciato headed, non solo in `--extension`. È l'esatto "guarda come faccio" (D.3.3 del 09-01) che abbiamo consegnato come `session_record observe` nella 1.16.0: **parità**, arrivata da loro il 24/08 e da noi il 02/09. Differenza: loro danno codice; noi jsonl rieseguibile dalla CLI + procedura leggibile + `export` Playwright con avviso sullo stato di login.
- **`browser_annotate`** (nuovo, non nel documento del 09-01): "Open the Playwright Dashboard in annotation mode for the current page and wait for the user to draw annotations. Returns the annotated screenshot, ARIA snapshot, and the list of annotations." Zero parametri, read-only. Più un tool che annota le azioni successive con un callout per screencast. È un canale umano→agente più ricco del nostro `handoff` (messaggio + Fatto + un solo elemento).
- **Screenshot senza downscaling** (#42406): `browser_take_screenshot` restituisce i byte originali "instead of silently downscaling them to model-specific limits". Direzione opposta ai nostri preset: da noi il controllo è esplicito (`scale`, preset), ed è giusto così.
- **Snapshot più compatto**: `--snapshot-boxes`, snapshot strutturato nelle risposte `--json` (#42098), YAML derivato dal JSON (#42169), `ariaSnapshotJSON()` in Playwright 1.63 con `mode/depth/boxes`. Public Browser (terzi, vedi B.2) misura la `view_page` di Playwright MCP a 1 911–2 269 caratteri a settembre contro 6 084 ad aprile: circa **3× più piccola**. Il "4× meno token" del README di luglio va riletto: il loro snapshot non è più il bersaglio grasso di prima.
- Posizionamento invariato: il README raccomanda ai coding agent la **CLI con skill** ("avoid loading large tool schemas and verbose accessibility trees"). Publish npm ripristinato via GitHub Actions il 09-03.

### A.3 chrome-devtools-mcp 1.9.0 (2026-09-08) e main

Fonti: release 1.9.0, diff `chrome-devtools-mcp-v1.8.0..main` letto nel clone, PR aperte #2612 e #2696.

- **Sicurezza configurabile**: `--no-javascript-evaluation` (spegne `evaluate_script` e lo slim `evaluate`, toglie `initScript` da `navigate_page`, vieta URL `javascript:`, `data:`, `vbscript:`; esteso alle navigazioni in #2638); **radici filesystem configurabili** per i file scritti (default cartella temp del SO, #2605); `--config` file JSON; `--no-sourcemaps`; `--screenshotFormat` di default; validazione esplicita di viewport e geolocalizzazione con messaggi che dicono il formato atteso; `src/utils/url.ts` con `isLocalhost/isAllowedUrl/validateUrl`.
- **Agent Plugins 1.0** (#2623): `plugin.json` + `mcp.json` con `$schema` di `agent-plugins.org`, standard "open, vendor-neutral" con TSC di Amazon, Cursor, Microsoft, OpenAI, Vercel; struttura = `plugin.json`, `skills/` (formato Agent Skills), `mcp.json` (stdio/HTTP/SSE). Anche real-browser-mcp porta il badge. Claude Code non è tra i firmatari, ma il formato coincide con quello che già abbiamo (`skills/chrome-bridge/SKILL.md`).
- **Skill `cookie-debugging`** (149 righe, con 4 scenari di eval in `scripts/eval_scenarios/`): HttpOnly vs `cookieStore`, sessione viva vs `isolatedContext`, consenso; PR #2696 aggiunge la skill `debug-in-devtools` e un comando plugin Claude.
- **Commenti in DevTools, bidirezionali** ("CD4A", dietro il flag nascosto `devtoolsComments`): `open_devtools`, `get_devtools_comments`, `resolve_devtools_comment` ("append an agent reply … and mark it as resolved"), `reveal_in_devtools` ("navigate DevTools to a specified panel and highlight a target DOM node or network request"). Il thread è `{id, text, networkRequestId?, backendNodeId?, editor?}`: l'utente scrive un commento nel pannello DevTools ancorato a un nodo DOM o a una richiesta di rete, il server lo riceve via `window.universe.cd4aBridge` (evento `CommentThreadsChanged`, debounce 200 ms) e lo manda al client come notifica. Richiede un frontend DevTools che espone il bridge (Canary). È il canale umano↔agente più strutturato visto finora, e non passa dalla pagina: passa da DevTools.
- **`get_css_styles`** (PR #2612 aperta, +832): regole matched, ereditate, pseudo-elementi, keyframes, at-rules, layer, container query, stato delle proprietà (`active/overloaded/invalid`) con paginazione; il `CssFormatter` (1 179 righe) è già su main. Serve CDP `CSS.getMatchedStylesForNode`: senza `debugger` noi possiamo solo approssimare.
- **Console preservata nelle navigazioni same-document** (#2676, SPA con `pushState`); URL lunghe troncate nell'output conciso della rete (#2513); target `chrome://` filtrati di default (#2648); `isolatedContext` in background onorato.
- **Telemetria estesa**: `flag_usage_metrics.json` (quali flag usa la gente), giorni dall'ultimo uso bucketizzati, "hermes client usage". Raccolta attiva di default, opt-out `--no-usage-statistics`. È il dato che a noi manca (B.4 del 09-01) e che loro raccolgono per default.
- Docs spezzate in `docs/configuration.md`, `docs/client-configurations.md` (406 righe), `docs/advanced-usage.md`; nome ufficiale "Chrome DevTools for agents"; install come estensione Gemini CLI.

### A.4 Agent360 browser-mcp 1.29.0 (2026-09-07), 49 commit

Fonti: clone (commit in danese, `Co-Authored-By: Claude Opus 5`), `WISHLIST.md`, `docs/PERFORMANCE-2026-09-08.md`, `content/browsermcp-docs-capability-matrix.md`. Manifest 1.29.0: 11 permessi (`debugger`, `tabGroups`, `cookies`, `notifications`, `webNavigation`, `offscreen`, …), `<all_urls>`.

Il valore di questi dieci giorni non è nelle feature: è che hanno **misurato i propri tool su una form React vera e pubblicato i difetti**. Elenco, perché ciascuno è una classe di bug che può esistere anche da noi:

1. `browser_click` rispondeva `ok:true` con `landed:false`: il fallback sparava senza misurare; poi si è scoperto che sparava **due** click (`dispatchEvent('click')` + `el.click()`), per cui i dropdown si aprivano e richiudevano. Ora `ok` è derivato dall'effetto, misurato con un'impronta della pagina prima/dopo (numero di nodi, testo visibile, URL, quanti elementi risultano aperti o selezionati).
2. `browser_fill` **appendeva** invece di sostituire (`test@example.dkanden@example.dk`, entrambe le chiamate `ok`): Cmd/Ctrl+A + Backspace come tasti veri non svuota un campo controllato React. Ora legge il campo dopo la pulizia e ripiega sul native setter.
3. `select_option` segnalava rollback su scelte riuscite (il framework sposta il valore altrove e resetta il DOM).
4. Lo screenshot in fallback usava `captureVisibleTab` e **fotografava la scheda dell'utente**, non quella dell'agente, senza che nulla nella risposta lo dicesse. Ora rifiutato.
5. `browser_scroll` a pixel andava in **timeout 30 s a ogni chiamata su ogni pagina**: `Input.dispatchMouseEvent mouseWheel` via CDP non risolveva mai e il fallback `scrollBy` stava in un `catch` irraggiungibile. Misurato: `get_page_content` 1 ms, `list_tabs` 2 ms, `navigate` 93 ms, `click` 6 056 ms, `scroll` 30 007 ms.
6. `Runtime.evaluate` era nella lista dei comandi ritentati automaticamente: **un'espressione mutante è stata eseguita quattro volte** quando il debugger si staccava ("quattro clic su un bottone che magari ordina qualcosa"). Tolto dalla lista: "we can't tell, so the default must be safe".
7. Porta presa all'avvio da ogni chat Claude Code: 37 server, 20 porte esaurite, 17 chat senza browser. Ora la porta si prende alla **prima chiamata browser**, si rilascia dopo 5 minuti dall'ultima scheda chiusa (`chrome.alarms`), `terminate` rilascia la porta e non il processo; identità della sessione legata al pid della chat, non alla porta (#17).
8. `set_combobox` impiegava 8,5 s a rifiutare una `<select>` nativa.

Prodotto: **capability matrix pubblica** con stati `Measured / By design / Not yet / Won't` e data per riga ("A capability list that only says yes is a brochure"); `WISHLIST.md` con la sezione "landed on main, not released" perché "è più onesto"; pagina "When NOT to use Browser MCP"; articolo sui form React con il fix del native setter (lo stesso che usiamo). Marketing: pagine SEO di confronto (mcp-chrome, playwright-mcp, browsermcp.io), ricetta SSH tunnel di un utente nel README, 462 trattini "da AI" rimossi dal sito, misura del posizionamento su Google ("stiamo su una parola su otto"). **Non ci citano**: il "mcp-chrome-bridge" nella loro pagina è il pacchetto npm di hangwin.

### A.5 Codex for Chrome (OpenAI): assente dal documento del 09-01

Fonti: docs `learn.chatgpt.com/docs/chrome-extension`, stampa (lancio 2026-05-07), snapshot di reverse engineering dell'estensione 1.1.4 in `iFurySt/open-browser-use/docs/references/` (data snapshot 2026-05-08).

- Estensione CWS "Codex" (id `hehggadaopoacecdllhhajmbjkdcmajg`), **16 permessi** tra cui `debugger`, `history`, `bookmarks`, `sessions`, `topSites`, `readingList`, `tabGroups`, `nativeMessaging`, `<all_urls>`. Native host `com.openai.codexextension`, JSON-RPC su pipe nativa (frame `uint32 length + JSON`), metodi `executeCdp`, `attach/detach`, `getTabs`, `getUserTabs`, `claimUserTab`, `createTab`, `finalizeTabs`, `nameSession`, `moveMouse`, ogni chiamata con `session_id` e `turn_id`.
- Richiede l'app desktop ChatGPT; macOS e Windows; Chrome, Edge, Brave, Opera, Vivaldi; approvazioni per sito ("Allow once / for this site / for all sites"), gruppi di schede per task, cronologia solo con approvazione per uso.
- Stessa classe di Claude in Chrome: proprietario, `debugger`, desktop soltanto, legato a un vendor. Da qui in poi il confronto "estensione ufficiale" nel README va fatto con entrambi.

### A.6 Gli altri noti

- **browsertap-mcp**: `feat!: harden shared browser sessions and recovery`, validazione dei path, policy privacy con categorie di dati e ritenzione. 2 stelle.
- **real-browser-mcp**: solo dipendenze; ha adottato Agent Plugins 1.0. 50 stelle.
- **hangwin/mcp-chrome** e **browsermcp/mcp**: nessun segno di vita; **Browserbase MCP**: fermo dal 07-20; **browser-use**: 100 commit, è un agente.

---

## B. Concorrenti nuovi (non nel documento del 09-01)

Ricerca su registry MCP (43 voci uniche, solo 3 aggiornate dal 09-01) e GitHub (tre query). Stelle e date lette oggi dall'API.

### B.1 Stessa tesi nostra: estensione + server locale sul Chrome reale

| Progetto | Stelle | Creato / push | Permessi estensione | Cosa aggiunge |
|---|---:|---|---|---|
| **Memel06/yurei** (CWS, npm `yurei-chrome`) | 6 | 09-03 / 09-10 | `debugger`, `scripting`, `tabs`, `storage`, `alarms`, `nativeMessaging`, `webNavigation` | native messaging + CLI; `setup` scrive `~/.agents/skills/yurei/SKILL.md`; "text-only models read the page as text, vision models screenshot". Otto giorni di vita, stessa forma della nostra |
| **lordamdal/chromeboost** (CWS) | 8 | 08-09 / 09-04 | `debugger`, `windows`, `downloads`, … | "anything irreversible stops and waits for you": evidenzia il bottone Post e aspetta il clic umano |
| **bpc-oss/chrome-faithful** | 6 | 08-14 / 08-21 | `debugger`, `history`, clipboard; host solo `127.0.0.1` | **pairing esatto per profilo** (registrazione con `profileName`, duplicati rifiutati), lancia un profilo chiuso, bridge fail-closed, manifest MCPB |
| **DeepakSilaych/chrome-mcp "LiveMCP"** | 4 | 04-24 / 09-08 | `debugger`, `cookies`, … | hub daemon con l'unica connessione all'estensione, N chat la condividono: il nostro relay |
| **hanelalo/browser-bridge** (Rust, WXT) | 50 | 08-02 / 08-30 | n.d. (WXT) | estensione + hub WS :9225 + CLI Rust + MCP `rmcp`; server auto-avviato che esce dopo 120 s di inattività; "ricette per sito" |
| **UHolli/browser-mcp** | 85 (979 fork, anomalo) | 06-22 / 09-03 | n.d. | estensione + WS :9009, Redis opzionale; generico |
| **iFurySt/open-browser-use** | 272 | 04-24 / 09-08 | `debugger`, `history`, `downloads`, `tabGroups`, … | clone open source del browser-use di Codex: estensione + CLI + SDK JS/Python/Go; contiene lo snapshot dell'estensione Codex |
| coda lunga (1–5 stelle) | | | | Capta1n-n9m0/chrome-agent-bridge, whg517/browser-bridge, HabaAndrei/custom-chrome-dev-mcp, Mehmoodqureshi/chrome-mcp, zeshuochen/nekoro-browser, cmsflash/agent-browser-mcp, virajverse/spectra-browser-mcp, leaf76/hermes-chrome, OUENMING/claude-code-browser, dashi96/chromium-bridge, nbiish/betterbrowsermcp-extension (fork di browsermcp con binding per scheda), G10hdz/Opencode-chrome, Quindart-com/opencode-chromium, TranHuyQn/cc-chrome-extension, lizard-build/lizard-studio (Claude Code CLI dentro il side panel), iola1999/codex-control-chrome-mcp (pilota Chrome **attraverso l'estensione Codex**) |

Lettura: la tesi "il tuo Chrome loggato via estensione" ha ormai **decine** di implementazioni, quasi tutte con `debugger`, quasi tutte da una persona, quasi tutte sotto 10 stelle. Il nostro "nessun `debugger`" resta raro: in questa lista lo ha solo slop-off (che non automatizza).

### B.2 CDP diretto sul Chrome reale, senza estensione

- **shaun0927/openchrome** (236 stelle, creato 2026-01-24, push 09-07, TS, MIT, npm `openchrome-mcp` 1.12.9). Si attacca al Chrome reale con `--auto-connect`, CLI `oc`, playbook YAML deterministici, daemon HTTP con token. Due idee da guardare:
  - **Tier dei tool**: tier 1 = 15 tool (navigate, computer, read_page, find, query_dom, interact, form_input, tabs, wait_for, screenshot, …); `expand_tools tier=2|3` scopre a runtime gli altri 100+ (`oc_*`: task, lane, run, skill record/recall/replay/export, evidence bundle, journal, checkpoint, diff, vitals, performance insights, recording start/stop/export, `element_pick` overlay in pagina, `image_qa`, `oc_totp_generate`, `oc_pilot_handoff_create/redeem`, `oc_browser_control` pausa→umano→ripresa con verifica di URL e account).
  - **Motore di hint**: regole (`blocking-page`, `console-buffer-pressure`, `error-recovery`, `pagination-detection`, `repetition-detection`, `sequence-detection`, `snapshot-stale`, `success-hints`) che appendono una riga "Hint: …" al risultato del tool quando riconoscono un pattern (pagina 404 dopo navigate, `find` senza risultati, stessa chiamata ripetuta).
  - Rapporto runtime del 2026-09-07 (in coreano): "non ripetere automaticamente scritture incerte", pausa umana con invalidazione dei ref vecchi, limiti di concorrenza per scheda. Superficie enorme, orientata a Codex.
- **Silbercue/public-browser** 2.10.1 (6 stelle, registry 09-03, TS, MIT). Si presenta come "the most token-efficient MCP server for Chrome automation". **Non è il Chrome che sta girando**: di default profilo temporaneo; con `--profile` lancia Chrome con una cartella wrapper che linka il profilo reale, e chiede di chiudere Chrome prima. 25 tool ≈ 4 990 token; ref a11y stabili con cache tra chiamate; **`run_plan`** (N passi in una chiamata, con variabili, condizioni, `saveAs`, strategie d'errore, sospendi/riprendi), `batch_evaluate` (stesso JS su N URL), `set_page_data` a chunk, `evaluate` con scanner di anti-pattern che avvisa su `querySelector`/`.click()`, Script API Python, isolamento per sessione in worker thread. Benchmark loro, settembre 2026, pagina da 35 test (30 valutati), driver `claude-opus-5`, contro Playwright MCP 0.0.80: token di sessione 6,3M/6,5M contro 8,8M/9,6M (−30%), costo $3,41/$3,35 contro $4,28/$4,78 (−25%), −41% chiamate, −40% tempo; ma la risposta media è **più grande** della loro (1 298 contro 740 caratteri). Numeri di parte, pubblicati con metodo.
- **JuliusBrussee/caveman-browse** (27 stelle, Go, un solo giorno di commit il 08-14). Si attacca al Chrome in esecuzione, **4 tool = 297 token** di catalogo contro 3 422 (Playwright 0.0.79) e 4 507 (DevTools 1.7.0), albero a11y compresso con recupero byte-exact; query mirata su una tabella da 200 righe ≈ 98 token. Onesto sul rovescio: sul task di checkout **perde** (668k contro 362k/312k) perché rifà lo snapshot dopo ogni azione. È la stessa conclusione del nostro benchmark: il catalogo non è il costo, i giri lo sono.
- **maestrojeong/browser-rs-mcp** (23 stelle, Rust 5,5 MB): un Chrome headful condiviso, **gruppi di schede isolati per agente** (`owner=research/operations/qa`), 68 tool, CDP grezzo multiplexato.

### B.3 Altre tesi, con idee riutilizzabili

- **DenDiem/caliper** (2 stelle ma su CWS, npm `@dendiem/caliper`): annotazioni UI e **bug trace** per agenti, in due direzioni. Il QA segna un elemento sulla pagina viva ed esporta selettore stabile + componente proprietario + stili calcolati abbinati ai design token; "Start trace" registra passi, mutazioni DOM, console con stack, richieste con stato e corpo, azioni dello store, più un video da ~1 MB: "the trace is what the agent reads, the video is for the human". L'MCP fa il verso opposto: l'agente chiede all'umano cosa intende su una regione.
- **wbso-ai/slop-off** (2 stelle, MV3 con soli `activeTab`, `scripting`, `storage`): l'utente **modifica il testo della pagina viva** e l'estensione produce un diff prima/dopo per elemento che l'agente applica al sorgente con una skill (`wait_for_report`, `get_latest_report`). "Judge the page, not the diff."
- **AetherAI3/agent-browser** 0.2.2 (4 stelle, Python, registry 09-04): Chrome self-hosted con vista **noVNC** in cui l'umano interviene al 2FA; 9 tool `browser_*`; demo con provenienza e checksum documentati.
- **hongnoul/hwatu** (80 stelle, Rust, AGPL): daemon **WebKit** per verifica visiva: "one-call verified page checks in ~35 ms", punteggio pixel-diff da far salire, animazioni come numeri, finestre che non rubano il fuoco; pensato per tiling WM. Non Chrome.
- **dondai44423/bladebro** (188 stelle, Rust, Apache-2.0): profilo persistente proprio (non il tuo Chrome), **5 tool** (`act`, `see`, `state`, `run`, `vision`), ref "immuni al re-render" via impronte strutturali, batch, 6 strati di stealth (68/80 sullo Stealth Bench di browser-use). Direzione stealth, non nostra.
- **atagon-GmbH/kogiqa-mcp** (103 stelle): "browser control algorithm" proprietario senza selettori, per debug di stile, fix di errori console, test e2e. Non è il Chrome dell'utente, algoritmo chiuso.
- Adiacenti, per completezza: CopilotKit/OpenBot 4,6k (coworker con un computer proprio), agent-infra/sandbox 5,9k, mozilla/firefox-devtools-mcp 401, achiya-automation/safari-mcp 183 (97 tool AppleScript), plasmate-labs/plasmate ("Semantic Object Model"), Crawlio browser agent (114 tool), 2captcha-mcp, WebMCP (npm-packages, opentiny/webmcp-sdk, doggy8088/agentready).

### B.4 Registry MCP ufficiale

43 voci uniche per `browser|chrome|extension`; dal 09-01 solo tre aggiornate: `io.github.Silbercue/public-browser` 2.10.1 (09-03), `io.github.AetherAI3/agent-browser` 0.2.2 (09-04), e un server di un sito immobiliare. La nostra voce è a **1.16.1 `isLatest`** (pubblicata 2026-09-02): il problema "registry fermo a 1.10.1" del 09-01 è chiuso.

---

## C. Cosa ci serve: informazioni utili e proposte

Ordine per valore/costo. Effort: S = ore, M = giorni. Per ciascuna: prova (chi/cosa), stato nostro **verificato oggi nel codice**, proposta, costo, impatto sullo schema (57 546 B a `caps=all`, misura del 09-01).

### C.1 Misurare l'effetto, non l'azione (click e type) — **S, da fare**

- **Prova.** Agent360 A.4 punti 1–3 (click "ok" senza effetto, fill che appende, select con falso rollback); OpenChrome "non ripetere scritture incerte"; caveman-browse perde il task di checkout proprio perché non sa quando l'azione ha avuto effetto e rifà lo snapshot.
- **Stato nostro.** `cmdClick` (`extension/service-worker.js:781`) controlla l'occlusione, poi dispatcha `pointerdown/mousedown/pointerup/mouseup` e **un solo** `el.click()` (niente doppio click: il bug di Agent360 non ci riguarda), e risponde `{clicked:true, tagName, text}` **senza guardare se la pagina ha reagito**. `type_text`/`fill_form` usano già il native setter + `input`/`change` (il fix corretto per React) ma non rileggono il valore dopo. Il server **non ritenta mai** un comando (nessun retry in `server/`, e la descrizione di `fill_form` avverte "not safe to retry blindly"): giusto, da tenere.
- **Proposta.** Nel content script, impronta prima/dopo (URL, `document.body.childElementCount`/numero nodi, lunghezza del testo visibile, conteggio di `[aria-expanded="true"]`, `[open]`, `:checked`, `activeElement`) e nella risposta di `click` un campo `effect: {url_changed, dom_changed, expanded_delta, focus_moved}`; in `type_text`/`fill_form` un `value_after` e `mismatch: true` quando differisce dal richiesto (poi, e solo allora, secondo tentativo con `typeMode:'keys'`). `wait_after` resta per chi vuole aspettare la navigazione.
- **Costo** S (solo estensione: review Store). **Schema** +≈80 B nelle descrizioni. **Valore**: chiude il ciclo "ok ma non è successo niente" che costa un turno di screenshot; è il difetto #19 di Agent360 e il nostro `execute_js` a 181 chiamate suggerisce che il modello oggi verifica a mano.

### C.2 Canale umano→agente più ricco del banner — **S/M, da fare**

- **Prova.** Playwright `browser_annotate` (disegni + screenshot annotato + ARIA + lista); DevTools comments (thread ancorati a nodo o richiesta, reply e resolve); Agent360 `browser_ask_user` (domanda in pagina, risposta testuale); chromeboost (aspetta il clic umano sul bottone irreversibile); Caliper (elemento + stili + trace); slop-off (l'utente edita, l'agente riceve il diff).
- **Stato nostro.** `handoff` = `message`, `pick_element` (un solo elemento: selettore, testo, box), `timeout` 5 min. Nessuna risposta testuale, nessuna selezione multipla, nessun disegno.
- **Proposta.** Due parametri: `ask: true` mostra un campo di testo nel banner e restituisce ciò che l'utente scrive (il "quale dei tre?" risolto con parole); `pick_element` accetta `max` (fino a N elementi, ciascuno con nota opzionale digitata dall'utente). Il disegno libero stile Playwright è un secondo passo; l'edit-in-place stile slop-off (modifica il testo, torna il diff) è un terzo, e ha valore reale per il "secondo paio d'occhi" (D.3.4 del 09-01).
- **Costo** S per `ask`, M per multi-pick. **Schema** +≈120 B. Nessun permesso nuovo.

### C.3 Sicurezza configurabile: spegnere l'esecuzione JS e recintare i file — **S, da fare**

- **Prova.** chrome-devtools-mcp 1.9.0 `--no-javascript-evaluation` + radici filesystem + `--config`; Playwright `--secrets` (già noto), `--allowed-origins`; OpenChrome daemon con token; chrome-faithful host permission solo `127.0.0.1`.
- **Stato nostro.** `CHROME_BRIDGE_CAPS` aggiunge gruppi (`audits, visual, network, storage, dom, files`) sopra un `core` **da cui `execute_js` non si toglie**; `save_to` accetta qualunque path assoluto; configurazione solo per variabili d'ambiente.
- **Proposta.** `CHROME_BRIDGE_NO_JS=1` toglie `execute_js` (e `modify_dom`, `inject_css` se presenti nei caps) dallo schema e rifiuta `javascript:`/`data:` in `navigate`; `CHROME_BRIDGE_WRITE_ROOT=/path` limita ogni `save_to`/`--out` a quella radice (default: nessun limite, come oggi, per non rompere la CLI). Un `--config chrome-bridge.json` opzionale è cosmesi, si può rimandare.
- **Costo** S. **Schema** −≈1 KB quando JS è spento. **Valore**: argomento per team e clienti che oggi non hanno un modo di dire "niente JS arbitrario nel mio browser"; e ci permette di misurare cosa si rompe davvero senza il tool numero uno.

### C.4 Agent Plugins 1.0 e marketplace Claude Code — **S, da fare**

- **Prova.** chrome-devtools-mcp (`plugin.json` + `mcp.json` con `${PLUGIN_DATA}`), real-browser-mcp (badge), caveman-browse (`/plugin marketplace add … && /plugin install`), TSC Amazon/Cursor/Microsoft/OpenAI/Vercel.
- **Stato nostro.** `skills/chrome-bridge/SKILL.md` c'è; nessun `plugin.json`, `mcp.json`, `.claude-plugin/`.
- **Proposta.** Aggiungere `plugin.json` (nome, versione allineata dal `chore(release)`, autore, repository, licenza, keyword), `mcp.json` (stdio `npx chrome-bridge-mcp@<versione>`), e un `.claude-plugin/marketplace.json` così l'installazione in Claude Code diventa due comandi senza `install.sh`. Un test unitario che la versione in `plugin.json` coincida con `package.json`.
- **Costo** S. **Schema** 0.

### C.5 Tabella di latenza pubblica, per tool — **S, da fare**

- **Prova.** Agent360 `PERFORMANCE-2026-09-08.md` (mediane su 5 giri, ha trovato lo scroll a 30 s e il click a 6 s); OpenChrome rapporto runtime con p50/p95 per candidato.
- **Stato nostro.** `bench/` misura turni e token, non millisecondi; il difetto aperto `tab_action close` a 30 s sul Terminale ChromeOS è esattamente la classe "timeout che nessuno misura".
- **Proposta.** `bench/latency.mjs`: spawn del server, JSON-RPC su stdio, 5 giri per tool su `example.com` e una pagina lunga, mediane in `docs/PERFORMANCE.md` con data; obiettivo dichiarato "nessun tool sopra 2 s su pagina statica". Riusa la launch mode degli e2e.
- **Costo** S. **Schema** 0.

### C.6 Capability matrix con stato e data — **S, docs**

- **Prova.** Agent360 (`Measured / By design / Not yet / Won't`); Playwright e DevTools con "Read-only" per tool nei README.
- **Stato nostro.** Il README ha la tabella "Why Chrome Bridge?" e i limiti sparsi (niente `debugger`, quindi niente breakpoint/heap/trace/`captureBeyondViewport`); nessuna riga dice "misurato il giorno X".
- **Proposta.** `docs/CAPABILITIES.md` con le stesse quattro etichette: login/2FA (`handoff`), CSP-strict (`execute_js` senza user scripts), iframe, shadow DOM, campi controllati React (native setter, **misurato** dopo C.1), `<select>` nativa, combobox div, date picker, upload, overlay, dialoghi, scroll infinito, `chrome://`, secondo profilo (`Won't`, come loro), ChromeOS. È anche il posto onesto per il difetto `tab_action close`.
- **Costo** S.

### C.7 Parità sul "guarda come faccio": differenziare sull'uscita — **0, solo docs**

Playwright restituisce codice; noi jsonl rieseguibile dalla CLI + procedura leggibile + `export` Playwright. Una riga nel README, fattuale, senza aggettivi. Nessun codice.

### C.8 Tier dei tool a runtime — **M, dopo**

OpenChrome `expand_tools`, DevTools `--slim`, Public Browser "25 tool in 4 990 token". Con Claude Code 2.1.267 i tool aggiunti a metà sessione arrivano come definizioni deferred senza rompere la cache: un `expand_tools` che manda `tools/list_changed` oggi sarebbe sostenibile lì. Sugli altri client resta il costo pieno. Da valutare dopo C.1–C.6; il valore sta tutto nei client senza deferral, che non misuriamo.

### C.9 Stili in cascata (`get_css_styles`) — **M, dopo**

Senza `debugger` non c'è `CSS.getMatchedStylesForNode`. Approssimazione possibile: scansione di `document.styleSheets` con `el.matches(rule.selectorText)` (solo fogli same-origin), ordine di specificità calcolato a mano, più `getComputedStyle`. Copre "perché questo bottone è rosso" nei progetti propri (fogli same-origin), non i CSS di terzi. `query_dom` con `properties` già dà i valori calcolati: prima chiedersi se il caso d'uso si è mai presentato (nel log del 09-01 `query_dom` era a zero).

### C.10 Multi-sessione: nuove prove, stessa priorità — **dopo**

browser-rs (gruppi per owner), chrome-faithful (pairing per profilo), Agent360 (37 server per 20 porte, identità per pid), OpenChrome (lane). Il nostro relay evita la corsa alle porte per costruzione; il calpestarsi è sui ref e sulla scheda implicita. Resta C1.7 del 09-01.

### C.11 Console e SPA — **niente da fare**

DevTools ha dovuto preservare la console nelle navigazioni same-document (#2676). Da noi il buffer è in pagina (`window.__chromeBridge_consoleLogs`, MAIN world) e sopravvive a `pushState`; si perde al reload completo finché `read_console` non reinstalla l'hook, ed è già documentato con `hooked`.

---

## D. Da non inseguire, e perché

- **Stealth** (bladebro, browser-rs, stealth-browser-mcp 1,9k stelle): Agent360 lo scrive meglio di chiunque: "works because it **is** your browser, not because anything is being circumvented. That sentence is the whole product". Vale identico per noi.
- **Cento tool** (OpenChrome 100+, Crawlio 114): il tier 1 di OpenChrome è 15 tool, cioè ammettono che il resto non deve essere visto.
- **noVNC / browser remoto** (agent-browser), **WebKit** (hwatu), **algoritmo chiuso** (kogiQA): altra tesi.
- **Commenti dentro DevTools** (CD4A): richiede il frontend DevTools con il bridge e CDP; il nostro equivalente è il banner in pagina (C.2), che funziona ovunque, anche su ChromeOS.
- **Telemetria d'uso attiva di default** (chrome-devtools-mcp): il dato ci manca, ma il pacchetto Store con "no telemetry" è parte della fiducia; se mai, opt-in esplicito con conteggi per tool e niente URL.

---

## E. Correzioni ai nostri testi (verificate oggi)

1. README tabella "Why Chrome Bridge?": il nostro "59 (38 core)" è **giusto** (misurato oggi con `npm run measure` e bloccato da `test/unit/tool-counts.test.js`; i 63/34 del documento del 09-01 erano pre-consolidamento 1.16.0). Stantie invece le colonne altrui: "Chrome DevTools MCP ~50" (29 di default, 56 con i flag), "Playwright MCP 23 core" (24), "Audits: Chrome DevTools Partial" (Lighthouse integrato già dal 09-01).
2. Ovunque diciamo che Claude in Chrome è "Windows e macOS soltanto" (documento del 09-01 §A.2, eventuali listing): Anthropic documenta Linux desktop; restano ChromeOS e WSL. La riga "ChromeOS / Crostini: No" per Claude in Chrome nel README resta vera.
3. Il confronto "estensione ufficiale" deve includere **Codex for Chrome** (OpenAI, dal 2026-05-07, `debugger`, desktop soltanto, app ChatGPT richiesta).
4. `docs/EFFICIENCY.md` e README: il "4× meno token di Playwright" citato da terzi a luglio è sorpassato dallo snapshot compatto di Playwright 0.0.80 (misura di Public Browser: ~3× più piccolo). La nostra frase "It wins on round trips, not payload size" resta corretta ed è l'unica da tenere.
5. Registry MCP: la nota "elenca 1.10.1" del 09-01 è superata (1.16.1 `latest`).

---

## Fonti

**API e clone (2026-09-11):** `gh api repos/<r>` e `/commits?since=2026-09-01`, `/releases`, `/pulls`; `npm view <pkg> time`; `registry.modelcontextprotocol.io/v0.1/servers?search=…`; clone shallow in scratchpad di ChromeDevTools/chrome-devtools-mcp (`--shallow-since=2026-08-24`), Agent360dk/browser-mcp, LinVireo/browsertap-mcp, Silbercue/public-browser, shaun0927/openchrome, UHolli/browser-mcp, dondai44423/bladebro, atagon-GmbH/kogiqa-mcp, hongnoul/hwatu, AetherAI3/agent-browser, JuliusBrussee/caveman-browse, maestrojeong/browser-rs-mcp, Memel06/yurei, iFurySt/open-browser-use, DenDiem/caliper, hanelalo/browser-bridge, ofershap/real-browser-mcp, DeepakSilaych/chrome-mcp, lordamdal/chromeboost, bpc-oss/chrome-faithful, wbso-ai/slop-off; PR microsoft/playwright #42359 (file e patch), PR chrome-devtools-mcp #2612, #2696; README `microsoft/playwright-mcp` (raw, main).

**Web:** `code.claude.com/docs/en/chrome`; `support.claude.com/en/articles/12012173`; `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`; `learn.chatgpt.com/docs/chrome-extension`; `agent-plugins.org`; stampa sul lancio di Codex for Chrome (MacRumors 2026-05-07, The New Stack); `developer.chrome.com/docs/devtools/agents`.

**Nostro codice letto oggi:** `extension/service-worker.js` (`cmdClick` 781, `cmdTypeText` ~850–910), `server/tools.js` (`TOOL_CAPS` 187, `handoff` 1619, `session_record` 2194), `server/` (nessun retry), `README.md` 43–66, `docs/store/listing.md` 40.
