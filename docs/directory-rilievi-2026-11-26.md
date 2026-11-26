# Rilievi del portale della directory su 1.32.9 — analisi file per file

Compito `directory-chrome-bridge-26-11`. Misura del portale letta dalla master il 26/11 alle 18:32 su bb2d161.
I blocchi «accepted only from Verified organizations» (hook command, server MCP locali, installazioni da lockfile,
file e campi fuori elenco) restano al Verified chiesto il 23/11 e qui non si toccano.

## 1. «Runs a pinned npx or uvx package» — correzione vera

**Dove:** `.claude-plugin/plugin.json` · `mcpServers.chrome-bridge`: `"command": "npx", "args": ["-y", "chrome-bridge-mcp@1.32.9"]`.

**Cosa fa davvero:** al primo avvio npx scarica da npm il pacchetto e le sue 4 dipendenze dirette
(`@modelcontextprotocol/sdk`, `ws`, `node-html-parser`, `@jridgewell/trace-mapping`), con le transitive fissate da
`npm-shrinkwrap.json`. Il codice che gira quindi non è quello che il portale legge nel repo: arriva da npm.

**Correzione:** il server va dentro il plugin, eseguito con `node ${CLAUDE_PLUGIN_ROOT}/dist/index.js`, come suggerisce
il portale. Misura del 26/11 (esbuild, ESM, node20, non minificato): 292 file sorgente, circa 2,0 MiB in tutto
(zod 1.020 KiB, server 394, sdk 230, node-html-parser 206, ajv 206, ws 129, il resto sotto i 60). Copiare i 292 file
così come sono porterebbe il plugin da 327 a 619 file, oltre il limite di 512. Quindi un bundle leggibile, non
minificato, diviso in pezzi sotto i 256 KiB e rigenerato a ogni release da uno script nel repo, con un test che fallisce
se il bundle non corrisponde al sorgente. `@paulirish/trace_engine` resta esterno, opzionale come oggi.

**Effetto per chi usa il plugin:** nessun peggioramento. Serve `node` come già oggi per npx. Il primo avvio non scarica
più niente e non dipende dalla rete. Il pacchetto npm resta com'è per chi usa `npx chrome-bridge-mcp` fuori dal plugin.
Le licenze delle dipendenze incorporate vanno nel repo accanto al bundle (MIT/ISC/BSD chiedono la nota).

## 2. «Dependencies install from a lockfile» — si risolve con il punto 1

**Dove:** lo stesso `mcpServers` più `npm-shrinkwrap.json` e `package-lock.json` alla radice.

**Cosa fa davvero:** è l'installazione fatta da npx al punto 1, fissata dal lockfile. Con il server nel plugin non
si installa più niente. I due lockfile restano alla radice perché servono al pacchetto npm, non al plugin: se il portale
li segnala ancora dopo il punto 1, il rilievo passa all'appello con questa spiegazione.

## 3. «Uses a credential from the user's machine» — serve una scelta (fuori dal repo)

**Dove (dedotto dal codice, il portale va riletto per la riga esatta):** `observe/observe.py`, copia sincronizzata da
claude-observe 3f264f6 (`observe/SOURCE`):
- r. 1114-1118 `gh_ok()`: `gh auth status`, cioè il login GitHub dell'utente;
- r. 1226-1237 `existing_issue()`: `gh issue list` per non aprire doppioni;
- r. 1460-1469: `gh api -X POST repos/…/security-advisories/reports` (segnalazione privata);
- r. 1532-1540: `gh issue create` / `gh issue comment` («Send from my GitHub»).

Possibile anche `server/ws-manager.js:46` (`process.env.CHROME_BRIDGE_TOKEN`), ma è un segreto che l'utente imposta
apposta per il relay, non una credenziale già presente sulla macchina.

**Cosa fa davvero:** solo dopo il sì dell'utente in `/chrome-bridge:observe send`, manda la segnalazione a nome suo con
il suo `gh`. Senza `gh` esistono già le alternative: link GitHub precompilato (r. 1414, `issue_link`) che l'utente apre
già loggato, e il modulo `security/advisories/new` (r. 1474).

**Correzione vera possibile, ma peggiora un poco:** togliere `gh` e usare sempre il link precompilato. Si perde
l'invio in un passo (l'utente deve premere «Submit» nel browser), la ricerca dei doppioni (si può rifare con l'API
pubblica di GitHub senza credenziali, 10 ricerche al minuto) e l'invio diretto della segnalazione privata. Il file va
cambiato in claude-observe, non qui: il prossimo `sync.py` lo rimetterebbe. Opzioni nel messaggio alla master.

## 4. «Code the directory may not be able to read» — dipende dalla riga citata

Due candidati, da confermare sul portale:
- **a) codice fuori dal plugin che observe esegue:** `observe/observe.py` r. 1100-1111 `anonymizer()`, che senza un
  anonimizzatore proprio cerca con un glob `~/.claude*/plugins/cache/*/fable-director/*/scripts/anonymizer.py` e lo esegue
  (r. 1130). Quel file non è nel plugin. Correzione vera: copiare l'anonimizzatore (13 KiB) in `scripts/anonymizer.py`
  del plugin, la prima scelta già prevista dal codice alla r. 1107, e togliere il glob in claude-observe. Nessun
  peggioramento: anzi gira la versione che il portale controlla.
- **b) il base64 di `server/cli.js`** (r. 190, 368, 435: `Buffer.from(…, 'base64')` → `writeFile`): decodifica gli
  screenshot e l'MHTML che il server manda in JSON e li scrive su file. Non esegue codice. Non c'è una correzione vera
  che non sia nascondere il punto: va all'appello.
- Se invece il portale cita il pacchetto npm (il codice scaricato da npx), lo risolve il punto 1.

## Dopo la lettura del portale (26/11, dalla master) e le scelte di Franz

- Rilievo 3 è `MCP_FORWARDS_CREDENTIAL_ENV` su 10 file, contati anche per la sola parola (`plugin.json` aveva solo
  «zero-token CLI»). Codice vero: `server/tools.js` (cookie del browser, credenziali Basic/Digest), `observe/observe.py`
  (`gh`, scelta B: resta) e `tools/cws-upload.mjs` (strumento di release dello Store).
- Rilievo 4 è `CODE_DECODED_AT_RUN_TIME` su `extension/service-worker.js` e `server/cli.js`; non cita `observe.py`, che
  per ora non si tocca.
- Strada A approvata da Franz alle 18:49: il plugin è `plugin/`, generato da `tools/build-plugin.mjs`, con il server
  incorporato in `plugin/dist/` (1.33.0). CHANGELOG, docs, test e `cws-upload.mjs` escono dal plugin distribuito, e
  con loro i lockfile. Nuova candidatura nel portale col percorso `plugin/`, a cura della master.

## Dopo la convalida del portale su 1.33.0 (26/11, 19:28)

- Blocchi solo da Verified: hook command, server MCP locale, `dist/cli.js`. «Will be refused» 12: credenziale 8, codice
  decodificato 2, `extension/manifest.json` (immagini) 1, `observe/py.sh` (script non seguito) 1. Avvisi 5: `icon`,
  `privacyPolicyUrl`, «download-and-run» ×3 (`RUNTIME_FETCH_EXEC`: `dist/server-1.js`, `extension/service-worker.js`,
  `observe/observe.py`).
- 1.33.1 (scelte della master nel piano approvato): `extension/` fuori da `plugin/` (il plugin non avvia mai
  `--launch`; senza la cartella `--launch` esce con un errore chiaro); `server/lighthouse.js` sostituito nel bundle da
  `tools/plugin-stubs/lighthouse.js`; `icon` e `privacyPolicyUrl` tolti.
- `observe/observe.py` e `RUNTIME_FETCH_EXEC`: nello stesso file c'è una richiesta di rete, r. 1392 `urlopen`, il POST
  dell'invio anonimo, la cui risposta si legge come JSON per prendere l'URL della issue. Ci sono anche processi
  avviati: r. 338 `Popen` di sé stesso (`auto-send`), r. 922 `git remote get-url`, r. 1116/1232/1462/1536 `gh`, r. 1130
  l'anonimizzatore. Niente di ciò che arriva dalla rete viene eseguito. Non si tocca qui (lo riscrive `sync.py`):
  appello, o una correzione in claude-observe proposta dalla master.

## Convalida del tag directory-1.33.1 (2004f49, 26/11 20:26)

3 blocchi solo da Verified (hook command, server MCP locale, `dist/cli.js`), 10 rifiuti, 3 avvisi. Cosa combacia,
verificato sui file del tag:

- `dist/vendor-ajv-1.js`: ajv chiama `env` il suo `SchemaEnv` (`constructor(env)`, `env.schema`, 25 volte). Non legge
  l'ambiente.
- `dist/vendor-node-html-parser-1.js`: i token del parser dei selettori CSS (`compileToken`, `DOMTokenList`) e il
  selettore `password: "[type=password]"`.
- `dist/vendor-ws-1.js`: r. 3645-3646 mette l'utente e la password scritti nell'URL `ws://user:pass@…` in `opts.auth`;
  r. 3693-3694 toglie `authorization` e `cookie` quando un redirect cambia host; r. 3707-3708 l'header Basic. Il
  client WebSocket di chrome-bridge si collega a `127.0.0.1` di default, mai con credenziali.
- `dist/vendor-zod-5.js`: il validatore di formato `z.jwt()` (r. 925, 1220), che controlla la forma di una stringa.
- `dist/server-1.js`: la redazione di `server/evidence.js` (r. 1162-1166, le regex che sostituiscono cookie, token e
  password con `[REDACTED]`) e il controllo dei banner cookie di `server/consent.js` (cookie prima e dopo il consenso).
- `dist/server-2.js`: `server/tools.js`, cookie del browser, `http_auth`, `SECRET_DIRS`/`SECRET_FILES` (r. 87-89).
- `.claude-plugin/plugin.json`: la sola parola «token» in «the zero-token CLI» della descrizione.
- `observe/py.sh`, «a zsh glob qualifier that runs code»: lo script gira con `bash` (lo lancia così l'hook) e non ha
  glob. Le uniche parentesi sono dentro l'argomento Python fra apici singoli, alla r. 15: `-c 'import sys;
  sys.exit(sys.version_info < (3, 8))'`. Il file viene da claude-observe.
- Avviso `RUNTIME_FETCH_EXEC` in `dist/server-1.js`: non è Lighthouse, la cui descrizione sta in `dist/server-2.js`
  r. 2308 («the first call downloads Lighthouse through npx», vera solo per il pacchetto npm). In `server-1.js` stanno
  invece tre cose diverse:
  - il controllo dei link di `server/link-checker.js` (r. 364, `fetch` HEAD/GET di cui si legge solo lo stato);
  - la lista dei tab dal DevTools locale `127.0.0.1` di `server/heap.js` (r. 2680);
  - `ffmpeg`, già installato dall'utente, avviato da `server/video.js` (r. 2507) sui fotogrammi catturati in locale.
  Niente di scaricato viene eseguito.

## Appello (testo finale per directory-1.33.1)

Testo da incollare, in inglese come il portale:

> **About the remaining findings on `directory-1.33.1`.** This tag is the `plugin/` folder of the repository at
> main 8a69a87, and nothing else. The MCP server and its CLI are in `dist/`, bundled from `server/` and not minified,
> with the licenses of the bundled packages in `dist/THIRD_PARTY_LICENSES.md`. Since 1.33.0 the plugin no longer runs
> `npx`. Since 1.33.1 it no longer ships the Chrome extension: the plugin never used that copy, and users get the
> extension from the Chrome Web Store. It also no longer ships the Lighthouse runner that fetched its CLI from npm.
> What is left, file by file:
>
> **Credential findings (MCP_FORWARDS_CREDENTIAL_ENV), 8 files.** No file reads a credential from the user's
> machine to send it anywhere.
>
> - `.claude-plugin/plugin.json`: the only match is the word «token» in «the zero-token CLI» in the description (a
>   CLI that costs no model tokens).
> - `dist/vendor-ajv-1.js`, `dist/vendor-node-html-parser-1.js`, `dist/vendor-ws-1.js`, `dist/vendor-zod-5.js` are
>   third-party libraries, bundled unchanged: ajv names its schema environment `env` (`SchemaEnv`, not the process
>   environment); node-html-parser has CSS selector tokens and the `[type=password]` selector; ws, the WebSocket
>   library, handles a `user:password` written in a `ws://` URL and drops `Authorization` and `Cookie` headers on a
>   cross-host redirect (chrome-bridge connects it to `127.0.0.1` by default, and never with credentials); zod has the `jwt()` string
>   format check.
> - `dist/server-1.js`: the matches are protections. The evidence report replaces cookies, tokens, `Authorization`
>   headers and password field values with `[REDACTED]` before anything is written. The cookie-banner audit compares the
>   page's cookies before and after the user's consent.
> - `dist/server-2.js` (the tools): the browser tools act inside the user's own logged-in Chrome. `http_request` sends a
>   request with that browser's cookies to the URL the user asked for, exactly as the page itself would. `cookie_audit`
>   lists the cookies of the open page so the user can audit them. `http_auth` keeps a Basic/Digest username and
>   password that the user passes in, in memory only, for the HTTP auth dialogs of the site being tested. Nothing is
>   read from disk: the server refuses to upload or save into `~/.ssh`, `~/.aws`, `~/.gnupg`, `.env*`, `*.pem`, `*.key`
>   and similar (`SECRET_DIRS` / `SECRET_FILES`, lines 87-89), and `--read-root` / `--write-root` can narrow the
>   readable and writable tree further.
> - `observe/observe.py`: the `/chrome-bridge:observe send` command sends the user's own error notes as one GitHub issue
>   only after the user picks «Send from my GitHub» in the options. That route uses the user's `gh` login to open the
>   issue in the user's name. Without `gh`, or if the user prefers, the same text opens as a prefilled GitHub link in
>   the browser, or goes through the anonymous route. The text is anonymized before it leaves, and nothing is sent
>   without that explicit choice.
>
> **Decoded code (CODE_DECODED_AT_RUN_TIME), `dist/cli.js`.** Lines 182, 360 and 427 decode base64 to write to disk the
> PNG screenshots and the MHTML snapshot that arrive in JSON over the local WebSocket; nothing decoded is executed. The
> `AsyncFunction` at line 272 is `chrome-bridge run`, which runs a script the user wrote and passes on the command line
> (`--code` or `--file`), with the chrome-bridge tools passed in as `cb`. Rewriting this would only hide the pattern from
> the scanner without changing what runs, so it stays as it is and readable.
>
> **Script not followed (COMMAND_SCRIPT_NOT_FOLLOWED), `observe/py.sh`.** This is the launcher of the hooks: it finds
> a Python 3.8+ (`python3`, `python`, `py -3`) and runs `observe.py` with it. The hooks start it with `bash`, and it
> contains no zsh glob. The only parentheses are inside the Python expression passed with `-c` in single quotes (line
> 15: `sys.exit(sys.version_info < (3, 8))`).
>
> **Download-and-run notices (RUNTIME_FETCH_EXEC).** Nothing fetched from the network is executed:
>
> - `dist/server-1.js`: the link checker sends HEAD/GET requests and reads only the status code; the heap tool reads the
>   tab list from the local DevTools endpoint on `127.0.0.1`; the screencast tool runs the user's own installed `ffmpeg`
>   on frames captured locally. The description of the `lighthouse` tool (in `dist/server-2.js`) still says that the
>   first call downloads Lighthouse through npx. That is true of the npm package. In this plugin the tool answers only
>   that it works in launch mode, and the plugin never starts launch mode.
> - `observe/observe.py`: its only network call is the POST of the anonymous report (`urlopen`), whose answer is read
>   as JSON to get the issue's URL. The processes it starts are `git`, the user's `gh`, the anonymizer and itself
>   (`auto-send`).
