# Checklist promozione gratuita — stato al 30 lug 2026

## Fatto (automatico)

- [x] Link CWS trovato e aggiunto a README + docs/index.md: https://chromewebstore.google.com/detail/chrome-bridge-for-claude/bioknpaeahidbelaljjohjofiloeodmb (1.7.0 live sullo store al 2026-07-30; 1.9.0 da caricare, richiede il TOTP)
- [x] PR su punkpeye/awesome-mcp-servers (sezione Browser Automation, fast-track agent PR): https://github.com/punkpeye/awesome-mcp-servers/pull/10534
- [x] `server.json` + campo `mcpName` in package.json — pubblicati sul registry ufficiale il 30 lug (vedi punto 1)
- [x] Doc submission Edge Add-ons: `EDGE-SUBMISSION.md` (zip 1.9.0 riutilizzabile tal quale)

## Da fare (richiede credenziali/azione umana)

### 0. Glama — FATTO il 2026-07-30
Badge `A – A`, release Glama v1.9.0, profile completion 58%. Badge aggiunto alla PR
#10534 (commit `2fb15174` su `add-chrome-bridge`) + commento al maintainer: la palla
è al suo campo.

Cose non ovvie, per la prossima volta:
- **Login senza credenziali**: `https://glama.ai/oauth/github/auth?returnPath=<path>`
  fa round-trip diretto se la sessione GitHub è già nel browser e Glama è già
  autorizzata. Niente password, niente 2FA.
- **La "release Glama" non è la release GitHub.** Serve: admin → Dockerfile → build
  spec → Build → a build verde → Create Release + numero di versione. Senza release,
  `Server Coherence` e `Tool Definition Quality` non vengono nemmeno calcolati.
- **Il Dockerfile del repo NON viene usato**: Glama genera il suo dal build spec, e
  quel form parte VUOTO (`buildSteps: []`, `cmdArguments: []`). Va compilato a mano —
  `["npm ci --omit=dev"]` e `["node","server/index.js","--caps","all"]`, con
  `--caps all` obbligatorio o i registry enumerano 31 tool su 60. Glama premette
  `mcp-proxy` da sola.
- **I campi JSON sono CodeMirror 6**: `Ctrl+V` sintetico non incolla (il paste vuole
  un evento trusted). Funziona dispatchare `new ClipboardEvent('paste', {clipboardData})`
  con un `DataTransfer` popolato.
- **`failed to resolve source metadata ... context deadline exceeded`** è
  infrastruttura loro: il primo build è morto così dopo 7m50s, il secondo identico è
  passato in 13s. Va solo riprovato.
- **Sync prima di ogni build**, o costruisce il commit vecchio: admin/repository →
  Sync Server.
- Il rilievo "missing dedicated cookie management" era un **falso negativo**: i cookie
  c'erano già in `get_storage`/`set_storage`. Prima di scrivere codice per un rilievo
  Glama, verifica che la capacità non esista già senza essere descritta.

### 1. Registry MCP ufficiale — FATTO il 2026-07-30
`io.github.frsorrentino/chrome-bridge` 1.9.0, `status: active`, package
`chrome-bridge-mcp@1.9.0`. Verificabile senza credenziali:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=chrome-bridge"
```

PulseMCP ingerisce da qui una volta al giorno, quindi non serve nessun form.

Per i rilasci futuri, con gli inciampi già trovati:

```bash
npm publish                                # richiede 2FA: OTP da authenticator, oppure
                                           # un granular token con "bypass 2FA" attivo.
                                           # Il codice che Google/npm manda via EMAIL al
                                           # login NON vale come --otp: risponde 403.
# il publisher del registry — il nome dell'asset NON si costruisce con uname -m:
# su questa macchina uname -m dà "aarch64" mentre l'asset è "linux_arm64", e quella
# URL scarica 9 byte di pagina d'errore che tar non sa aprire.
gh release download --repo modelcontextprotocol/registry --pattern "mcp-publisher_linux_arm64.tar.gz"
tar xzf mcp-publisher_linux_arm64.tar.gz
./mcp-publisher login github               # device flow: stampa un codice per
                                           # github.com/login/device, scade in pochi minuti
./mcp-publisher validate                   # falli qui, non al publish
./mcp-publisher publish
```

**`description` in `server.json` deve stare in 100 caratteri**, o il publish muore con
`422 expected length <= 100` — la nostra era 208. Il conteggio dei tool va comunque
citato nel testo, perché `test/unit/tool-counts.test.js` lo presidia.

### 2. mcp.so
Form già individuato (https://mcp.so/submit): URL `https://github.com/frsorrentino/chrome-bridge`, nome `Chrome Bridge`, opzione **Free submission** → richiede account email+password (nessun OAuth GitHub). Registrati e reinvia: 2 minuti.

### 3. awesome-claude-code
PR vietate; solo form web e la policy richiede che la submission sia fatta da un umano:
https://github.com/hesreallyhim/awesome-claude-code/issues/new?template=recommend-resource.yml

Descrizione da incollare (stile richiesto: descrittivo, una riga, no emoji, no sales pitch):

```
MCP server and Chrome extension that connect Claude Code to the user's real, logged-in Chrome over a local WebSocket, exposing 59 token-efficient web-development tools (compact element refs, server-side table filtering, visual regression, accessibility/SEO/security audits, network mocking), including on ChromeOS/Crostini.
```

### 4. Edge Add-ons
Segui `EDGE-SUBMISSION.md` (registrazione Partner Center gratuita + upload zip esistente).

### 5. Lanci one-shot (dopo benchmark completo)
- Show HN: titolo tipo "Show HN: Chrome Bridge – MCP server that drives your real Chrome, 2-3× fewer tokens than Claude in Chrome". Prima conviene completare il benchmark vs claude-in-chrome (run cic interrotti su pairing — vedi memoria/bench).
- r/ClaudeAI + Discord Anthropic: post con angolo "token efficiency", link benchmark.
