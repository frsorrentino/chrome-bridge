# chrome-bridge — verifica concorrenti 2026-09-25 (dal 2026-09-11)

**Versione nostra:** 1.22.0 (npm, registry MCP `latest`, Store in revisione; il 24/09 la 1.21.0 aveva chiuso il ciclo `get_css_styles`).
**Precedente:** `docs/analisi-2026-09-11-concorrenti.md`. Qui si dà per letto e si tratta solo ciò che il brief dei trend X del 25/09 (`personali/docs/trend-x-claude-code-2026-09-25.md`) ha portato a galla: un concorrente nuovo che vende **il nostro stesso concetto**, una skill che abbiamo scartato per posizionamento e non per merito, e una famiglia di MCP adiacenti (design-to-code) che il mercato affianca ai browser tool.
**Metodo (tutto consultato il 2026-09-25):** README raw di `Tencent/BrowserSkill` (17,7 KB), pagina GitHub (stelle, fork) e post X di lancio; `skills/browser-use/SKILL.md` raw di `browser-use/browser-use` (10,5 KB); `npm view @playwright/mcp` e README di `microsoft/playwright-mcp` (main); pagine GitHub/Glama di `ccpopy/codesign-mcp`, `wplaunchify/design-clone-mcp`, `Kargatharaakash/website-design-systems-mcp`; ricerca web per gli altri cloni di design. L'API GitHub ha risposto con `TLS handshake timeout` per tutta la sessione: i numeri di stelle vengono dalle pagine HTML, non dall'API. Dove un numero è di terzi è scritto.

---

## A. Tencent BrowserSkill — lo stesso concetto, detto meglio

Fonti: README (main, 25/09), post `@TencentAI_News` del 16/09 (365k visualizzazioni il 25/09 alle 14:15, letto dal master), pagina GitHub: **7,2k stelle, 519 fork** in nove giorni, MIT. Rust + pnpm; tag di release non letti (API in timeout).

**Cosa è.** Un CLI (`bsk`) con daemon in background e un'estensione per Chrome ed Edge (Chromium 125+, Web Store `hhcmgoofomhgciiibhipgmgkgnoenaoi`). L'agente non parla con il browser: chiama `bsk`, il daemon tiene sessioni, schede e permessi, l'estensione esegue. Niente MCP: **skill + CLI**, installata con `bsk install-skill` per Cursor, Claude Code, Codex, OpenClaw, CodeBuddy, WorkBuddy, Pi, Hermes; per DeepSeek Harness un plugin con tool nativi `browser_*`. Comandi visti nel README: `session start|stop`, `navigate`, `observe`, `screenshot [--full-page]`, `browsers`, `install-skill`, `doctor`, `status`, `update`, `daemon restart`.

**La frase che ha vinto il post:** *«most tools give the agent a blank browser. We let it borrow a tab from yours, then hand it back»* — login già presente, captcha e conferme tornano all'utente, poi si riprende. È la tesi di chrome-bridge dal primo giorno (README: «your real, logged-in Chrome»; `handoff` dal 1.13, `CAPABILITIES.md` riga «Site requires a login: Measured (daily use)»). Loro l'hanno messa nel titolo; noi nel benchmark.

**Cosa fanno che noi non facciamo**

- **Agent Window.** Le schede dell'agente vivono in una finestra propria; una scheda dell'utente si «prende in prestito» con una conferma nel browser e **torna da sola nella finestra d'origine** a fine sessione (`session stop`, anche dopo un fallimento). Da noi le schede di sessione sono marcate `mine` e chiuse a fine sessione (`tab_action close_session`), ma una scheda dell'utente su cui l'agente lavora non ha un «restituiscila».
- **Interruttori lato browser che il CLI non può scavalcare.** «Confirm before borrowing tabs» e «Allow requests for human help» stanno nel popup dell'estensione; dalla 0.3.0 `--unattended`, `tab borrow --no-confirm` e `BSK_REQUEST_HELP=off` sono deprecati e **non li sovrascrivono**. Il consenso è dove l'agente non arriva. Noi non abbiamo alcun consenso lato estensione: chi ha il socket ha tutto.
- **Edge**, oltre a Chrome. Noi Chrome soltanto.
- **Una skill per nove harness** e un plugin nativo per DSH; guida per sandbox che uccidono i processi in background (`BSK_HOME` condiviso, `BSK_AUTO_START=0`). Noi: Claude Code (plugin), Agent Plugins 1.0, e il resto «copia la skill a mano».
- **Operation audit** locale (spento di default, metadati senza valori, 30 giorni) e **evidence JSON** del debugging (richieste, risposte, console) da esportare. Noi abbiamo `chrome-bridge evidence` (fascicolo con hash) e claude-observe (errori nostri), non un audit delle operazioni.
- **Self-update** (`bsk update --yes`, riavvia il daemon) e `doctor`. Noi: `get_status` e l'installazione da Store/npm.
- **Casi di valutazione riproducibili** (`evals/browser/README.md`). Noi: 373 unit + 32 e2e, nessun eval «da agente».
- **Selezione del profilo** con un nome dato in BrowserSkill (`bsk browsers`, `session start --browser "Work profile"`). Noi: il profilo è quello dove gira l'estensione, uno.

**Cosa facciamo noi che loro non fanno** (dal README loro; l'assenza è «non nel README», non «impossibile»)

- **MCP con ref nella stessa risposta** (`navigate` restituisce `n1…`; `click ref`), oltre alla corsia CLI a zero token. Loro solo CLI+skill: zero schema, ma ogni azione è una shell e un parse.
- **ChromeOS/Crostini**: loro macOS, Linux, Windows; ChromeOS non nominato. Restiamo i soli.
- **Headless / launch mode** per CI: loro «requires visible browser», esplicito.
- **Audit in una chiamata** (a11y, keyboard, SEO, security, link, vitals, css, resources, cache), `cookie_audit`, `track_events` (pixel decodificati), `screenshot_diff` (anche contro mockup e fra due URL), `get_css_styles`, `measure_spacing`, `watch` in background, `find_setting`. Niente di tutto questo nel loro README.
- **Osserva-e-rigioca**: `session_record observe` → jsonl rieseguibile + procedura leggibile + export Playwright con avviso sullo stato di login. Loro: nessuna registrazione.
- **`handoff` con `pick_element`/`pick_max`/`ask`**: la persona clicca l'elemento o scrive nel banner. Loro: «request human help» per login/verifica, senza canale di ritorno strutturato descritto.
- **Mocking di rete con errori forzati e latenza** (`network_rules replay` con `status`/`latency_ms`): loro hanno filtro, blocco, mock e replay same-origin — parità sul mock, non sugli errori forzati (da verificare nel codice, non solo nel README).
- **Numeri misurati** (2,75× turni, 2,28× costo, `docs/PERFORMANCE.md`). Loro nessun benchmark pubblicato.

**Verdetto.** Non è un tool più potente del nostro: è il nostro concetto con un nome, un'immagine e un lancio da 365k visualizzazioni fatto da Tencent. Le due cose da imparare non sono funzionalità ma **posizionamento** (la scheda in prestito nel titolo, non nella terza riga) e **consenso lato estensione** (un interruttore che il socket non scavalca). La seconda è anche una risposta ai security scanner di `docs/reputazione-2026-09-24.md`.

## B. browser-use come skill (`browser-use skill install`)

Fonti: `skills/browser-use/SKILL.md` (main, 25/09), docs cloud. Repo 114k stelle (09-11), progetto che vive di Browser Use Cloud.

**Cosa è.** `browser-use skill install` registra una SKILL.md che insegna a Claude Code (e Codex, Hermes, OpenClaw) un CLI `browser-use` guidato da **heredoc Python** (`browser-use <<'PY' … PY`, con `agent-workspace/agent_helpers.py`). Due strade: **Chrome locale via CDP** — si attacca al Chrome in esecuzione, lo lancia se manca, ma **serve `chrome://inspect/#remote-debugging` abilitato** (e su macOS un popup «Allow remote debugging?» con `mac-approve`); oppure **Browser Use Cloud** — browser Chrome gestiti, «clean managed IPs and stealth settings», profili cloud con sync dei soli cookie, a pagamento finché non li fermi. La skill dice di proporre il cloud «proactively» per task paralleli e per «captchas or blocking likely».

**Cosa fanno che noi non facciamo**

- **Stealth e proxy** per non essere bloccati (cloud, a pagamento). Fuori dalla nostra tesi: noi siamo il browser vero dell'utente, con il suo IP, il che è il valore per il fascicolo di prova e per i pannelli di hosting.
- **N browser isolati in parallelo** (un cloud browser per task). Noi: sessioni multiple sullo stesso browser (primary/relay), tab per sessione.
- **Scripting arbitrario** in Python sul CDP: qualunque cosa, nessun catalogo. Noi 60 tool con contratto; `execute_js` per il resto, nella pagina.
- **Regola «curl prima del browser»** nella skill: se una fetch basta, niente browser. Buona, e la nostra SKILL.md non la dice.
- **SSO automatico quando Chrome è già loggato**, stop su password/MFA/consenso/scelta di account. Da noi lo stesso principio è in `handoff` e in «Out of reach».

**Cosa facciamo noi che loro no**

- **Niente porta di debugging**: la loro strada locale richiede il remote debugging acceso, cioè qualunque processo locale può guidare il browser. La nostra estensione MV3 senza `debugger` non apre quella porta, e non mostra il banner «Chrome is being controlled».
- **ChromeOS**: il remote debugging del Chrome host non è raggiungibile da Crostini.
- **Handoff nella pagina** (banner, Done/Cancel, pick, ask): loro «stop and ask» in chat, la persona deve tornare al terminale.
- Audit, diff visivo, pixel, cookie audit, watch, osserva-e-rigioca, evidence: assenti nella skill.

**Verdetto.** Confermato lo scarto del 09-01/09-11: è un agente/cloud, non un bridge. Da prendere: la riga «se basta una fetch, niente browser» (`http_request` esiste già, la skill non la propone come prima scelta).

## C. Playwright MCP 0.0.82 (2026-09-18)

Fonti: `npm view` (0.0.82 pubblicato il 18/09), README main. Il 09-11 era 0.0.80.

Il README oggi spiega tre modi di tenere lo stato: **profilo persistente** per workspace (`ms-playwright/mcp-{channel}-{workspace-hash}`, un'istanza per profilo), **isolato** (`--isolated`), e **`--extension`**: «connect to existing browser tabs and leverage your logged-in sessions and browser state» tramite la Playwright Extension, con `--profile-dir-name` per scegliere il profilo. Quindi anche Playwright MCP fa la «scheda in prestito» — ma è un'opzione, non la tesi, e passa per CDP con la sua estensione.

- **Loro, non noi:** `browser_annotate` (disegni dell'utente sullo screenshot), codegen Playwright dalla registrazione, tracing, PDF, profili per workspace, matrice di installazione per venti client, `--isolated` per test puliti.
- **Noi, non loro:** ChromeOS; niente `debugger` né banner di automazione; audit/diff/pixel/cookie/watch/evidence; `handoff` con canale di ritorno; il CLI a zero token sopra il bridge già connesso (il loro `@playwright/cli` apre il proprio browser).

Nulla di nuovo da fare rispetto al 09-11 (C.2 canale umano→agente più ricco resta la voce aperta).

## D. CoDesign MCP e i cloni di design: adiacenti, non concorrenti

Il brief li mette nella stessa frase dei browser tool perché nelle rassegne su X compaiono insieme. Letti uno per uno:

| Progetto | Cosa fa | Browser | Stelle |
|---|---|---|---|
| `ccpopy/codesign-mcp` (npm `codesign-mcp`) | Legge i link di condivisione di **Tencent CoDesign** (tool di design collaborativo): artboard, spec dei layer (testi, colori, CSS, coordinate), slice esportate, anteprime; metadati «platform-adjusted» (iOS/Android/web/mini program). Login via QR in un Chromium proprio con profilo persistente; userscript «Copy for AI» | Chromium proprio, solo per il login | 15 |
| `wplaunchify/design-clone-mcp` | Un tool, `clone_website_design(url)`: HTML (≤50 KB), 20 colori, 10 font, stili computati per sezione, layout. «Only publicly accessible websites» | Puppeteer con Chromium incluso, headless | n.d. |
| `Kargatharaakash/website-design-systems-mcp` | `extract_design_system` → un `skill.md` con palette, scala tipografica, spaziature, radius, ombre, breakpoint, logo/favicon; `get_site_colors`, `get_site_typography`, `validate_url` | **nessuno**: HTTP puro con rotazione di user-agent | 17 |
| `Manavarya09/design-extract` | Token DTCG (primitive/semantici/compositi), emitter per SwiftUI/Compose/Flutter/WordPress/Tailwind/Figma/shadcn, audit CSS e WCAG, estensione Chrome | Playwright | n.d. |
| `SarthakMishra/site-cloner`, `maoxiaoke/mcp-copy-web-ui`, skill «clone-website»/«pixel-perfect cloner» (mcpmarket) | Fetch, analisi e download degli asset di un sito per ricostruirlo; la skill «clone-website» usa un Chrome MCP per ispezionare, estrae token e asset, scrive spec dei componenti e lancia builder in parallelo | Vari; la skill si appoggia a un browser MCP qualsiasi | n.d. |

**Cosa fanno che noi non facciamo:** producono **un artefatto di design** (token DTCG, `skill.md`, CSS variables, spec per piattaforma) a partire da un URL o da un file di design. Noi leggiamo (`query_dom` con proprietà computate, `get_css_styles` con la cascata, `measure_spacing`, `screenshot_diff` contro il mockup) ma non emettiamo un file di token.
**Cosa facciamo noi che loro no:** lavoriamo sulla **pagina loggata e viva** (area riservata, back office, staging dietro basic auth con `http_auth`), mentre tutti loro leggono solo URL pubblici o un Chromium proprio; e confrontiamo l'implementazione con il design (`screenshot_diff from_file`), non solo ne estraiamo i valori.
**CoDesign** non è un concorrente in nessun senso: è un lettore di file di design di un prodotto Tencent, citato accanto a BrowserSkill solo per il nome dell'azienda.

## E. Cosa ne facciamo

1. **README, npm, Store — S, oggi.** La scheda in prestito dal *tuo* Chrome, con il tuo login, e `handoff` per captcha e conferme vanno nella prima riga, non nel benchmark: siamo arrivati prima e non lo diciamo. Fatto in questo ciclo (vedi commit), in inglese, sobrio, senza nomi.
2. **Consenso lato estensione — M, proposta.** Un interruttore nel popup («Confirm before the agent uses one of my tabs» / «Allow the agent to ask for my help») che il server non può scavalcare, e una scheda dell'utente presa in prestito che **torna** nella finestra d'origine a fine sessione (`move_tab` esiste già; manca «ricorda da dove veniva»). È la parte di BrowserSkill che vale, ed è anche una risposta ai security scanner. Da decidere; non fatto.
3. **«Se basta una fetch, niente browser» — S, skill.** Una riga in «How to work»: `http_request` prima di `navigate` quando la pagina è pubblica e serve solo il testo o uno status. Non fatto: la skill è sotto audit in questo stesso ciclo, meglio una modifica sola.
4. **Token di design in uscita — 0.** Un `design_tokens` che sputa palette/tipografia/spaziature dalla pagina viva sarebbe un tool in più su un mercato di 15-17 stelle. Non inseguire; se serve, `query_dom` + `get_css_styles` + un file scritto da Claude.
5. **Eval «da agente» — S, in corso.** BrowserSkill pubblica casi di valutazione; `claude plugin eval` esiste dall'11/09. Suite minima: la skill scatta su screenshot/debug visivo/DOM, non scatta quando l'utente chiede claude-in-chrome. Fatto in questo ciclo (`evals/`).

## Fonti

Tencent BrowserSkill: `https://github.com/Tencent/BrowserSkill` (README raw main, pagina repo: 7,2k stelle, 519 fork), post `https://x.com/TencentAI_News/status/2100143086429217278`, blog terzi (samuellawrentz.com, explainx.ai, xugj520.cn) per il changelog 0.3.0 (`--unattended` e `--no-confirm` non scavalcano più gli interruttori del browser). browser-use: `https://raw.githubusercontent.com/browser-use/browser-use/main/skills/browser-use/SKILL.md`, `https://github.com/browser-use/browser-harness` (install, profile-sync). Playwright MCP: `npm view @playwright/mcp` (0.0.82, 2026-09-18), `https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md`. CoDesign: `https://github.com/ccpopy/codesign-mcp`, `https://glama.ai/mcp/servers/ccpopy/codesign-mcp`. Cloni di design: `https://glama.ai/mcp/servers/wplaunchify/design-clone-mcp`, `https://github.com/Kargatharaakash/website-design-systems-mcp`, `https://github.com/Manavarya09/design-extract`, `https://github.com/SarthakMishra/site-cloner`, `https://github.com/maoxiaoke/mcp-copy-web-ui`, mcpmarket.com (skill clone-website, pixel-perfect cloner). Nostro: `README.md`, `skills/chrome-bridge/SKILL.md`, `docs/CAPABILITIES.md` righe 17-18, `server/tools.js` (`handoff` 1838), `docs/reputazione-2026-09-24.md`.
