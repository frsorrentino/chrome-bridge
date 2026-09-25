# Candidatura di chrome-bridge alla directory Anthropic — 2026-09-25

Preparato il 25/09/2026 su richiesta di Franz (via master). Il modulo lo invia Franz; qui ci sono il percorso corretto, il testo di ogni campo e ciò che manca. Tutte le fonti sono state lette il 25/09 alle 22:00 circa.

## 0. Dove si candida davvero (il modulo è cambiato)

- `https://clau.de/plugin-directory-submission` **non è più un modulo**: risponde 302 verso `https://code.claude.com/docs/en/plugins#submit-your-plugin-to-the-official-marketplace`, e quell'ancora non esiste più nella pagina. Il README di `anthropics/claude-plugins-official` (letto il 25/09) rimanda ancora al link, con la sola frase «External plugins must meet quality and security standards for approval».
- La pagina `code.claude.com/docs/en/plugins/publish` dice testualmente: «Anthropic's official marketplace, `claude-plugins-official`, doesn't take submissions through the directory portal. If you work with an Anthropic partner contact, ask them about an official-marketplace listing.» Quindi il marketplace ufficiale (quello dei sei partner della settimana) è **a invito**; non c'è un modulo aperto.
- Il canale aperto a chiunque su piano a pagamento è la **directory Anthropic** (developer portal `https://claude.ai/directory/manage`, «Submit new» → «Plugin bundle»). Una scheda lì è visibile su claude.ai, app desktop/mobile, Cowork e arriva in Claude Code come plugin `chrome-bridge@synced` (`syncClaudeAiPlugins`, quello che `adozione.py` non vede). `claude.com/docs/directory/publish`: «The earlier Claude Console form for plugin submissions is no longer supported».
- Requisiti per inviare: piano Pro/Max/Team/Enterprise (Max di Franz va bene); account GitHub collegato a claude.ai **nella stessa organizzazione** da cui si invia, con permesso di push su `frsorrentino/chrome-bridge`; repo pubblico prima della pubblicazione (lo è). La prima organizzazione che invia una coppia repo+cartella la possiede per sempre: inviare dall'account che deve restare proprietario.
- Limiti: 10 invii per organizzazione ogni 24 h (bozze e ritiri contano); una sola submission per repo+cartella.

**Raccomandazione:** candidare alla directory dal portale. Per il marketplace ufficiale non esiste un percorso senza contatto partner; se Franz ne ha uno, il testo qui sotto vale anche lì.

## 1. Il portale non ha campi di testo liberi: la scheda si legge dal repo

Passi del modulo (`claude.com/docs/plugins/submit`), con cosa mettere:

| Passo | Campo | Valore per chrome-bridge |
|---|---|---|
| Source | Repository | `frsorrentino/chrome-bridge` |
| Source | Plugin path (optional) | vuoto: `.claude-plugin/plugin.json` è alla radice |
| Source | Branch or tag (optional) | vuoto = `main`. Alternativa: un tag (es. `chrome-bridge--v1.22.0` creato con `claude plugin tag --push`) se si vuole che la directory non riceva ogni commit di `main`. Con `main` ogni push viene riscansionato e, finché il reviewer pubblica ogni versione, resta in coda: consigliato il **tag** finché non arriva l'auto-publish |
| Source | Validate | da premere nel portale; il report vale per un commit solo, ripetere dopo ogni push |
| Listing details | (nessun campo editabile) | nome, descrizione breve e testo lungo vengono da `plugin.json` e dal `README.md` |
| Data handling | 4 domande | vedi §3 |
| Compliance | contact email + 4 acknowledgement | `fr.sorrentino@gmail.com`; spuntare i quattro |
| Review and submit | How new versions reach the directory | **GitHub push webhook** (default; serve admin del repo per il webhook) |
| Review and submit | Auto-publish passing versions | **on** (Anthropic decide se applicarlo; di default un reviewer pubblica ogni versione) |

### 1a. Testo dei campi letti dal repo (già nel repo, da confermare)

- **name** (immutabile): `chrome-bridge`. Rischio: due parole generiche, e il README stesso dice «not affiliated with other projects named chrome-bridge». La checklist prevede **«Name may be confused with an existing listing»** (hold per reviewer, non blocco) e blocco solo se un'altra organizzazione ha già listato lo stesso nome. Non si può cambiare dopo la pubblicazione: se si vuole un nome più distintivo (es. `chrome-bridge-for-claude`, come il nome Store «Chrome Bridge for Claude»), è **adesso** o mai, ma romperebbe le installazioni esistenti da marketplace (`chrome-bridge@chrome-bridge`) salvo `renames` in marketplace.json. Proposta: tenere `chrome-bridge` e aggiungere `displayName`.
- **displayName** (da aggiungere a `plugin.json`, oggi assente): `Chrome Bridge for Claude` — stesso nome dello Store.
- **description** (`plugin.json`, oggi 296 caratteri; il portale la usa come descrizione breve): «Borrow a tab from your own logged-in Chrome and hand it back: navigate, read, fill, audit, diff and record in the browser you already use; logins, 2FA and CAPTCHAs stay with you (handoff). ChromeOS included, no debugger permission. Ships the chrome-bridge skill (recipes) and the zero-token CLI.»
- **author.name**: `frsorrentino` (unico sistema di scrittura, nessun brand altrui). **author.url** `https://github.com/frsorrentino`.
- **homepage**: `https://github.com/frsorrentino/chrome-bridge#readme`; **repository** `https://github.com/frsorrentino/chrome-bridge`; **license** `MIT` (c'è anche `LICENSE` alla radice); **version** `1.22.0` (alzare a ogni release, la directory lo pretende).
- **Descrizione lunga** = README.md (≥ 40 parole fuori dai blocchi di codice: sì). Va bene com'è dopo il commit 17f3acf (scheda in prestito + handoff in prima riga). Le immagini del README (`assets/readme/card*.png`) sono referenziate con sintassi Markdown immagine: conforme.
- **Categoria**: il portale non la chiede; nel nostro `marketplace.json` è `productivity`. Nel marketplace ufficiale i plugin browser sono sotto categorie tipo `development`/`testing`: se mai un partner contact chiedesse, dire **Development tools / Testing**.

## 2. Verifica del repo contro la checklist di pre-submission (25/09, commit 17f3acf + working tree)

Fonte: `claude.com/docs/plugins/pre-submission-checklist`. Esito per riga.

**Passa (verificato)**
- `.claude-plugin/plugin.json` alla radice; `claude plugin validate --strict .` → `✔ Validation passed` (Claude Code 2.1.282; il comando ha convalidato `.claude-plugin/marketplace.json`).
- README ≥ 40 parole, `LICENSE` MIT alla radice.
- 233 file tracciati (< 512); `git archive HEAD` = 4,5 MB (< 50 MiB); nessun file > 5 MiB; gli unici file > 256 KiB sono tre PNG in `docs/store/screenshots/` (le immagini sono esenti).
- Nessun binario non ammesso tracciato: gli zip dell'estensione stanno in `dist/`, che è ignorato da git. Nessun file minificato o `vendor`.
- Nessun `.npmrc`; nessuna credenziale nei file; nessun `${user_config.*}`.
- `hooks/hooks.json`: JSON valido, eventi standard, comandi `python3 "${CLAUDE_PLUGIN_ROOT}/observe/observe.py" …` con percorso completo da `${CLAUDE_PLUGIN_ROOT}`; non è elencato nel campo `hooks` di plugin.json (giusto).
- Skill `skills/chrome-bridge/SKILL.md` con front matter valido e `description` testuale.
- Nessun `.DS_Store`/`Thumbs.db`; nomi file validi su Windows/macOS; nessun `.gitattributes` con `export-ignore`/`filter`.
- Sorgente leggibile (niente codice compilato o packato): la security scan può leggerlo.

**Hold per reviewer, inevitabili con l'architettura attuale (non bloccano)**
- **«Runs a pinned npx or uvx package»**: il server parte con `npx -y chrome-bridge-mcp@1.22.0` (pinnato: ok, ma sempre in hold perché le dipendenze si risolvono all'installazione). Alternativa che toglie l'hold: `node ${CLAUDE_PLUGIN_ROOT}/server/index.js`, ma allora `node_modules` non c'è: servirebbe la seconda voce sotto.
- **«Dependencies install from a lockfile»**: `package.json` + `package-lock.json` alla radice → Claude Code installa le dipendenze all'installazione del plugin, e il reviewer le guarda. Le dipendenze runtime sono 4 (`@modelcontextprotocol/sdk`, `ws`, `node-html-parser`, `@jridgewell/trace-mapping`).
- **«Scripts the validator couldn't follow»**: non si applica (plugin alla radice del repo), ma i hook eseguono un file Python: al reviewer va spiegato in README cosa fa `observe/observe.py` (lo fa già la sezione «What leaves your machine», righe 218-252).

**Warning (non bloccano, da sistemare se costa poco)**
- `.claude/skills/chrome-bridge` è un **symlink** a `../../skills/chrome-bridge`: «Commit regular files… not symbolic links» → warning perché il plugin non lo carica (carica `./skills/`). Serve solo alla sessione locale: rimuoverlo dal repo prima dell'invio evita la riga nel report.
- `displayName` assente (vedi §1a).

**Da fare prima dell'invio**
1. Aggiungere `displayName` a `.claude-plugin/plugin.json` (e a `plugin.json` Agent Plugins per coerenza).
2. Decidere branch o tag da far seguire (consiglio: tag).
3. Collegare GitHub a claude.ai nell'organizzazione da cui si invia.
4. Facoltativo: togliere il symlink `.claude/skills/chrome-bridge` dal tracciamento git.

## 3. Data handling: risposte proposte (in inglese, come vanno nel portale)

Le quattro domande sono: dati personali letti/conservati; invio a servizi diversi dai connettori dichiarati; durata di conservazione; destinato a minori di 18 anni.

- **Does the plugin read or store personal data?** — «It reads whatever is on the pages the user asks it to work on, in the user's own logged-in Chrome, and passes that page content to the model like any browser tool. Nothing is stored by the plugin except files the user explicitly asks for (screenshots, HAR/CSV exports, saved pages) under a path the user chooses (`--write-root` can fence it), plus a local error log of failed tool calls (`~/.local/state/claude-observe/chrome-bridge.jsonl`, mode 0600, no page content).»
- **Does it send data to services other than its declared connectors?** — «No. The MCP server binds loopback only and talks to the browser extension over `ws://127.0.0.1:8765`. The plugin has no telemetry. The only outbound path is the optional `/chrome-bridge:observe send`, which prepares an anonymized GitHub issue (or a private security advisory) and sends it only after the user says yes.»
- **How long does it keep data?** — «Until the user deletes the files they asked for. The local error log rotates per claude-observe defaults and can be disabled (`CHROME_BRIDGE_OBSERVE=off` or `{"enabled": false}` in `~/.config/claude-observe/config.json`).»
- **Intended for people under 18?** — «No.»

Coerente con la privacy policy dello Store (`docs/privacy.md`, «everything stays on your machine») e con la sezione README «What leaves your machine». Se il reviewer chiede una privacy policy URL: `https://frsorrentino.github.io/chrome-bridge/privacy`.

## 4. Sicurezza: cosa dire e cosa manca

Cosa c'è già e va citato nel README/scheda (la security scan cerca «behavior that a plugin doesn't disclose»):
- Loopback bind, controllo origine `chrome-extension://`, `CHROME_BRIDGE_TOKEN` su entrambi gli handshake; `--caps core` di default, `--no-js`, `--write-root`, `--read-root`; `upload_file` rifiuta chiavi e credenziali (README «Security» + «Threat model», righe 184-215).
- `SECURITY.md` con private vulnerability reporting su GitHub.
- Il triage AgentSeal del 24/09 (docs/reputazione-2026-09-24.md) e il rescan chiesto.

Cosa manca o è debole per un reviewer:
- **Nessun consenso lato estensione** (analisi concorrenti §E.2): chi ha il socket ha tutto. BrowserSkill ha due interruttori nel popup che il CLI non può scavalcare. Non è un requisito della checklist, ma è la prima domanda che un reviewer di sicurezza farà a un plugin che «gives an AI agent your real, logged-in browser».
- **Il token non è obbligatorio**: senza `CHROME_BRIDGE_TOKEN` un processo locale può fare da relay verso `execute_js` (lo dice il README stesso). Valutare token di default generato al primo avvio.
- **Il hook Python** (`observe/observe.py`) gira a ogni `SessionStart`/`Stop`/`PostToolUseFailure`: descriverlo in una riga nel README all'inizio della sezione hook, non solo nella tabella delle variabili.

## 5. Test, licenza, screenshot: cosa manca

- **Test**: 373 unit (`npm test`, verdi il 25/09) + 32 e2e (`npm run test:e2e:launch`, non rieseguiti oggi) + eval `claude plugin eval` (`evals/`, 9/9 fire, 0/9 no-fire). Il badge README dice ancora «257 unit + 32 e2e»: **aggiornare a 373**. La checklist chiede di eseguire l'eval prima dell'invio: fatto il 25/09 pomeriggio.
- **Licenza**: MIT, `LICENSE` presente. Ok.
- **Screenshot**: il portale **non chiede screenshot**; la scheda mostra il README, quindi le cinque card `assets/readme/card*.png` sono le immagini della scheda. Le tre screenshot dello Store (`docs/store/screenshots/`) non servono qui.
- **Superfici**: dalla tabella `claude.com/docs/plugins/platform-support`, un **server MCP locale (stdio) è ignorato in Chat** (claude.ai web/mobile) e carica in Cowork «when the Cowork session runs on your computer» e in Claude Code; i **hook sono ignorati in Chat**; la **skill carica ovunque**. Quindi su claude.ai la scheda darà solo la skill (che senza server non fa nulla): il portale lo mostra prima dell'invio come «Runs in each session». Da dire nel README con una riga: «On claude.ai chat the plugin loads only the recipes skill; the tools need Claude Code or Cowork on your computer.»
- **Conflitto con il marketplace proprio**: chi ha già `chrome-bridge@chrome-bridge` e attiva il plugin dalla directory si ritrova anche `chrome-bridge@synced`: due server uguali. Riga nel README, accanto a «Pick one path».

## 6. Cosa fa Franz, in ordine

1. `displayName` in plugin.json, badge test a 373, riga «claude.ai loads only the skill», riga sul doppio `@synced` → commit + tag `chrome-bridge--v1.22.x` (o release 1.23.0).
2. Su claude.ai: **Customize → collegare GitHub** nell'organizzazione personale.
3. `https://claude.ai/directory/manage` → Submit new → Plugin bundle → Repository `frsorrentino/chrome-bridge`, tag scelto → **Validate** → leggere il report (attesi gli hold npx/lockfile; nessun blocco atteso).
4. Data handling con le risposte del §3; Compliance con la mail; webhook on; Submit for review.
5. Quando la versione «passes every check» o il reviewer la libera: **Publish** (il reviewer pubblica la prima versione).

## Fonti (lette il 2026-09-25)

- https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/README.md
- https://clau.de/plugin-directory-submission (302 → code.claude.com/docs/en/plugins#submit-your-plugin-to-the-official-marketplace, ancora assente)
- https://code.claude.com/docs/en/plugins/publish («Submit to Anthropic's directory»)
- https://claude.com/docs/directory/publish
- https://claude.com/docs/plugins/submit
- https://claude.com/docs/plugins/pre-submission-checklist
- https://claude.com/docs/plugins/platform-support
