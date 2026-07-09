# Design: pubblicazione su Chrome Web Store

**Data:** 2026-07-09
**Stato:** approvato dall'utente (conversazione 2026-07-09)
**Obiettivo:** pubblicare l'estensione "Chrome Bridge for Claude Code" (v1.5.0) sul Chrome Web Store come listing pubblico, con una submission che possa passare la review Google al primo giro.

## Decisioni prese

| Decisione | Scelta |
|---|---|
| Destinazione | Chrome Web Store, listing **pubblico** |
| Strategia permessi | Tutti obbligatori nel manifest + giustificazioni scritte per il form CWS |
| Esecuzione codice arbitrario | Migrazione da `eval()` a **`chrome.userScripts.execute()`** |
| Privacy policy | `docs/` su GitHub Pages del repo |
| Lingua listing | Solo inglese |
| Account developer | Da creare (registrazione a carico dell'utente, $5) |

## Contesto e vincolo bloccante

L'estensione (MV3, 56 tool via WebSocket `localhost:8765`) esegue oggi codice JS arbitrario ricevuto dal server MCP tramite `eval()` dentro `chrome.scripting.executeScript`:

- `service-worker.js:461` e `:481` — tool `execute_js` (ISOLATED world con fallback MAIN)
- `service-worker.js:3348` — tool `wait_for` con `expression` JS (`cmdWaitForFunction`)

La policy CWS ("Blue Argon": no remotely hosted code / no arbitrary code execution) vieta questo pattern ed è la causa di rigetto più comune per estensioni di automazione. Il fatto che il codice arrivi da localhost non è considerato esimente dai reviewer.

**Via sanzionata:** l'API `chrome.userScripts` esiste esattamente per questo caso d'uso (è quella usata da Tampermonkey). `chrome.userScripts.execute()` (Chrome 135+) permette iniezione one-shot di stringhe di codice utente in un tab, nei world `USER_SCRIPT` o `MAIN`. Richiede che l'utente attivi una volta il toggle "Allow user scripts" nella pagina dettagli dell'estensione (Chrome 138+; in 135-137 serve Developer Mode globale).

## 1. Compliance codice

### Refactor dei 3 punti eval

- `cmdExecuteJs`: sostituire i due blocchi `chrome.scripting.executeScript + eval` con una singola chiamata `chrome.userScripts.execute({ target, js: [{ code }], world })`. Strategia world invariata nello spirito: prova `USER_SCRIPT` (equivalente isolato, non soggetto a CSP di pagina), fallback `MAIN`. Il valore di ritorno arriva in `InjectionResult[].result` come oggi.
- `cmdWaitForFunction`: l'intera funzione di polling diventa codice stringa passato a `userScripts.execute()` (l'espressione utente viene interpolata/valutata dentro il codice iniettato, non più `eval` dentro una func di `executeScript`). Parametri `timeout`/`polling_ms` interpolati come letterali JSON.
- Nessun altro uso di `eval` / `new Function` / `importScripts` dinamico nell'estensione (verificato via grep). Tutti gli altri tool usano `chrome.scripting.executeScript` con `func` statiche + `args`: pattern pienamente compliant, resta invariato.

### Manifest

- `permissions`: aggiungere `"userScripts"`.
- `minimum_chrome_version`: `"111"` → `"135"`.
- `version`: `"1.5.0"`.
- `description`: riscritta in inglese più descrittiva (≤132 char), coerente col listing.
- Aggiungere `homepage_url`: `https://github.com/frsorrentino/chrome-bridge`.

### Degradazione se toggle non attivo

`chrome.userScripts` lancia eccezione se l'utente non ha abilitato "Allow user scripts":

- Helper `userScriptsAvailable()` nel service worker (try/catch su accesso API, pattern documentato da Google).
- `execute_js` e `wait_for` (solo variante `expression`) restituiscono errore parlante: *"User scripts are disabled. Open chrome://extensions, click Details on Chrome Bridge, and enable 'Allow user scripts'."* Gli altri 54 tool non sono toccati.
- Popup: riga di stato/warning quando il toggle è spento, con la stessa istruzione.
- Descrizioni tool lato server (`server/`): nota sul requisito toggle per `execute_js` e per il parametro `expression` di `wait_for`.

### Test

- La suite esistente (`test/test-devtools.js`, `test/unit/`) deve passare dopo il refactor.
- Verifica manuale end-to-end: `execute_js` e `wait_for expression` funzionanti con toggle attivo; errore parlante con toggle spento.

## 2. Privacy policy + GitHub Pages

- `docs/index.md`: landing minima del progetto (nome, pitch, link GitHub, link privacy).
- `docs/privacy.md`: privacy policy in inglese. Punti obbligati:
  - L'estensione non raccoglie, non trasmette e non vende alcun dato utente.
  - Tutta la comunicazione avviene esclusivamente con un processo locale (`ws://localhost:8765`); nessun server remoto.
  - I permessi ampi (cookies, clipboard, webRequest, ecc.) sono usati solo per eseguire i comandi che l'utente stesso impartisce via Claude Code, sul proprio browser.
  - Nessun analytics, nessun tracking, nessun account.
- GitHub Pages attivato su branch `main`, cartella `/docs`. URL finale: `https://frsorrentino.github.io/chrome-bridge/privacy`.
- Nota: la cartella `docs/superpowers/` (specs e piani) resta nel repo; accettabile che sia servita da Pages, non linkata dalla landing.

## 3. Asset e testi del listing (inglese)

Tutti i testi in `docs/store/`:

- `docs/store/listing.md`:
  - Nome store: "Chrome Bridge for Claude Code".
  - Summary ≤132 caratteri.
  - Descrizione lunga (feature, architettura locale-only, requisito server MCP companion, link repo).
  - **Single-purpose statement**: browser automation bridge that lets the user's local Claude Code CLI inspect and drive their own browser.
- `docs/store/permissions-justifications.md`: una giustificazione per ciascuno dei 15 item — `tabs`, `scripting`, `userScripts`, `alarms`, `storage`, `cookies`, `webNavigation`, `webRequest`, `declarativeNetRequest`, `clipboardRead`, `clipboardWrite`, `downloads`, `pageCapture`, `webRequestAuthProvider`, `host_permissions <all_urls>` — pronte da incollare nel form CWS.
- Dichiarazioni data-usage nel form: "does not collect or transmit user data" (nessuna delle categorie CWS raccolta).
- Screenshot 1280×800 (target 3, minimo 1), generati usando chrome-bridge stesso: popup connesso, tool in azione su una pagina, output in Claude Code. Salvati in `docs/store/screenshots/`.
- Promo tile 440×280 derivata dall'icona 128px esistente, in `docs/store/`.

## 4. Packaging

- `scripts/package-extension.sh`: produce `dist/chrome-bridge-extension-<version>.zip` dal contenuto di `extension/` (manifest in root dello zip, esclusi file non necessari). Versione letta dal manifest.
- Bump 1.5.0 sincronizzato: `extension/manifest.json` + `package.json`.

## 5. Submission (checklist per l'utente)

`docs/store/submission-checklist.md`, passo-passo:

1. Registrazione account developer su https://chrome.google.com/webstore/devconsole ($5 una tantum).
2. Upload zip.
3. Dove incollare: summary, descrizione, single-purpose, giustificazioni permessi, privacy policy URL, dichiarazioni data-usage.
4. Upload screenshot e promo tile.
5. Categoria (Developer Tools), lingua (English), visibilità (Public).
6. Submit for review; cosa aspettarsi (tempi, possibili richieste di chiarimento).

## Fuori scope

- Localizzazione italiana del listing.
- Promo video.
- Permessi opzionali runtime (`optional_permissions`).
- GIF recording, CDP, headless (limiti noti del prodotto, non della submission).

## Rischi

- **Review permessi ampi:** anche con userScripts, `<all_urls>` + `webRequest` + `cookies` su listing pubblico può generare un giro di rejection con richiesta chiarimenti. Mitigazione: giustificazioni dettagliate; eventuale resubmit è fisiologico.
- **Requisito Chrome 135:** esclude Chrome 111-134. Accettato: il target (utenti Claude Code su Chrome recente) non ne risente in pratica.
- **Toggle "Allow user scripts":** frizione UX una tantum per `execute_js`/`wait_for expression`. Mitigata da errori parlanti + warning nel popup + note nelle descrizioni tool.

## Criteri di successo

1. Zip pronto per upload, zero `eval` nell'estensione, suite test verde.
2. Privacy policy raggiungibile all'URL GitHub Pages.
3. Tutti i testi del form CWS pronti da incollare.
4. Screenshot e promo tile conformi alle dimensioni richieste.
5. Checklist submission completa per l'utente.
