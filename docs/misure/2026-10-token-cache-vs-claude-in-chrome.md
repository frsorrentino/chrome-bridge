# Token e cache: chrome-bridge contro Claude in Chrome con Claude Code 2.1.302

Misura del 16-17/10/2026 (compito cb-misura-token-cache-20261016). Il motivo è
il changelog della 2.1.302: «Changed where the Claude in Chrome instructions
sit in the system prompt so that new conversations can read them from the
shared prompt cache». Prima di ripetere in pubblico «meno token» bisogna sapere
se il vantaggio regge. Nessun cambio di codice né di testi pubblici.

In breve: sulla 2.1.302 chrome-bridge costa 3,9-6,1 volte meno di Claude in
Chrome sugli stessi compiti (30 run appaiate su win, 15/15 risposte corrette
contro 14/15). Claude in Chrome perde ancora la cache al primo ToolSearch: 15
run su 15, in media 19,3k token riscritti ogni volta. È il 31% del suo costo
per run su form, il 47% su heavy e il 13% sul debug, dove i turni sono tanti.
chrome-bridge non la perde mai: 0 casi nelle run e 0 su 279 caricamenti nelle
sessioni reali.

## Metodo

Tre fonti:

1. **Richieste vere.** Un proxy locale (`ANTHROPIC_BASE_URL` verso un server
   Node che salva il corpo di `/v1/messages`, senza header) ha catturato le
   richieste di sessioni minime `claude -p` con la stessa configurazione MCP del
   benchmark. Il proxy cambia due comportamenti: con un base URL non di prima
   parte Claude Code spegne la ricerca dei tool (riaccesa con
   `ENABLE_TOOL_SEARCH=true`) e la cache condivisa fra sessioni, quindi la
   prima richiesta parte sempre a freddo. Dal proxy si prende solo la
   **disposizione** del prompt. I numeri di cache vengono dalle run senza proxy.
2. **Trascrizioni reali** (`~/.claude/projects/*/*.jsonl`, ultimi 60 giorni,
   solo thread principale). Per ogni ToolSearch si confronta la richiesta
   successiva con la precedente. Conta come rottura quando `cache_read` scende
   sotto il 90% di `cache_read + cache_creation` della richiesta prima. Restano
   fuori gli intervalli oltre 50 minuti e i cambi di modello. Le sessioni
   girate in `/tmp` e in scratchpad, cioè il benchmark, sono contate a parte.
3. **Telemetria fable-director** (`telemetry.db`, eventi `mcp_meter` e
   `mcp_schema_load`) e run del benchmark. Quelle storiche stanno sul branch
   `bench-results`. Le nuove `t302` sono girate su **win** (Claude Code 2.1.302,
   stesso account), perché il Chromebook era sopra la soglia di carico. Usano
   chrome-bridge `ae8606c` con `--caps core` e Chrome headless di win. Il
   braccio Claude in Chrome pilota il Chrome del Chromebook (deviceId
   ammesso, controllato a ogni run). Le pagine stanno sulla porta 8097, servite
   su win per chrome-bridge e sul Chromebook per Claude in Chrome, perché la
   8099 era occupata da un'altra sessione.

## 1. Dove Claude Code 2.1.302 mette le cose

Ordine della richiesta: `tools` → `system` → `messages`. La cache si legge per
prefisso: una differenza in un punto riscrive tutto quello che viene dopo.

| parte | contenuto | condivisa fra sessioni? |
|---|---|---|
| `tools` | built-in, poi i tool MCP non differiti | sì, se identici |
| `system[2]` (statico, `cache_control` 1h) | prompt di Claude Code; **in fondo la sezione «# Claude in Chrome browser automation», 3.586 caratteri** | sì |
| `messages[0]` (user) | CLAUDE.md, contesto, attribuzione, prompt | no |
| `messages[1]` (role `system`, breakpoint) | uscite degli hook SessionStart, Environment, agenti, **«# MCP Server Instructions» con le istruzioni di chrome-bridge, 2.538 caratteri**, elenco skill, hook UserPromptSubmit, data | no |

- **Claude in Chrome**: il changelog è confermato. Le sue istruzioni stanno nel
  blocco statico del system prompt, quindi una conversazione nuova le legge
  dalla cache condivisa.
- **chrome-bridge**, come ogni server MCP di terze parti: le istruzioni stanno
  nel messaggio di sistema per sessione, dopo le uscite degli hook che cambiano
  a ogni avvio (ora locale, recap). Non entrano mai nella cache condivisa, e il
  server non può spostarle. Costo: circa 640 token scritti una volta per
  sessione (TTL 1h) e poi letti a 0,1× per turno.
- **Tool.** Con la ricerca dei tool attiva, che è il default di prima parte,
  chrome-bridge in `--caps core` manda 22 tool interi nel blocco `tools`
  (`alwaysLoad`, 28.256 caratteri JSON). Gli altri partono `defer_loading`.
  Claude in Chrome non manda tool interi: tutti differiti più un
  `DeferredToolPlaceholder`. I tool di chrome-bridge sono identici fra
  sessioni. Lo mostrano le 5 run di ogni cella del 29/09, che alla prima
  richiesta leggono lo stesso prefisso condiviso (42.684 token).
  `server/instructions.js` e le descrizioni non contengono dati variabili:
  `VERSION` compare solo nell'initialize e nel risultato di `get_status`.

## 2. ToolSearch e rotture di cache: la differenza grossa

Dal proxy, sulla 2.1.302 con la ricerca dei tool attiva (n=1 per arm):

- **Claude in Chrome**: dopo `ToolSearch select:…list_connected_browsers` la
  richiesta 2 legge 26.172 token e ne **riscrive 27.576**. Causa nel corpo: il
  `DeferredToolPlaceholder` passa da prima a dopo `Write` nell'array `tools`.
  L'ordine cambia, quindi si rompe il prefisso da lì in avanti.
- **chrome-bridge**: dopo `ToolSearch select:…get_frames` il nuovo tool entra
  `defer_loading` a metà array. La richiesta 2 **rilegge tutti i 60.799 token**
  e ne scrive 316: i tool differiti non spostano il prefisso.

Nelle trascrizioni degli ultimi 60 giorni, tutte su versioni precedenti alla
2.1.302:

| sessioni | evento | caricamenti | rotture | token riscritti per rottura (media) |
|---|---|---:|---:|---:|
| reali | ToolSearch di tool chrome-bridge | 275 | **0** | – |
| reali | `get_status({enable})` (tools/list_changed) | 4 | 0 | – |
| reali | ToolSearch di tool Claude in Chrome | 25 | **18 (72%)** | **94.951** |
| benchmark | ToolSearch di tool Claude in Chrome | 33 | 27 | 27.988 |
| reali | ToolSearch di tool non MCP | 364 | 2 | – |

Le 18 rotture reali di Claude in Chrome hanno riscritto 1,71 milioni di token.
Una rottura costa la scrittura 1h (2× l'input) al posto della lettura (0,1×):
su 95k token sono circa 180k token-input equivalenti in più, ogni volta.

La 2.1.302 promette di correggere «una cache persa quando un tool caricato a
metà sessione si ricarica». Non è questo caso. Nelle run `t302` senza proxy
(sezione 4) la rottura di Claude in Chrome al primo ToolSearch c'è in **15 run
su 15**: la richiesta 2 rilegge solo i primi 32.176 token del prefisso e
riscrive il resto, in media 19.254 token per run. chrome-bridge: 0 rotture su
15.

## 3. Costo di avvio di una sessione (dati del 29/09, Claude Code 2.1.29x)

Scomposizione per richiesta delle run `v1251a` (chrome-bridge) e `v125b`
(Claude in Chrome), a cache calda:

| arm | richiesta 1 | richiesta 2 | cache scritta per run (mediana) |
|---|---|---|---:|
| chrome-bridge, form | legge 42.684, scrive 27.008 | legge 69.692, scrive 437 | 28.349 |
| Claude in Chrome, form | legge 25.546, scrive 29.356 | **legge 25.546, scrive 35.183** | 71.118 |
| Claude in Chrome, heavy | legge 25.546, scrive 29.049 | **legge 25.546, scrive 32.961** | 99.347 |

- I circa 27-29k scritti alla prima richiesta sono uguali nei due arm: è il
  messaggio per sessione (hook, skill, CLAUDE.md) di questa macchina, non il
  server.
- Il prefisso condiviso di chrome-bridge è più lungo di circa 17k token: i tool
  `alwaysLoad`. Si paga a 0,1× per turno ed è scritto una volta per ora fra
  tutte le sessioni.
- Claude in Chrome riscrive 33-35k token al primo ToolSearch: il meccanismo
  della sezione 2. Per questo scrive in cache 2,5-3,6 volte chrome-bridge per
  run, prima ancora di contare i turni in più (heavy: altri 34k sono il testo della
  pagina letto con `get_page_text`, non una rottura).

## 4. Serie appaiate sulla 2.1.302 (win, 17/10 00:33-01:08)

n=5 per braccio e per compito, `claude-sonnet-5`, bracci alternati run per
run, ordine invertito nei giri pari. Tutte le run incluse. La run sonda
`t302probe` è esclusa: è servita a verificare il collegamento a Claude in
Chrome prima del giro, non fa parte del set. Mediane, tra parentesi min-max:

| compito | braccio | turni | cache scritta | cache letta | $/run | corrette |
|---|---|---:|---:|---:|---:|---:|
| **form** | **chrome-bridge** | **3** (3) | 1.183 | 166k (111-166k) | **0,043** (0,042-0,254) | 5/5 |
| form | Claude in Chrome | 15 (14-15) | 25.563 | 556k (516-570k) | 0,236 (0,224-0,291) | 5/5 |
| **heavy** | **chrome-bridge** | **3** (3-4) | 627 | 166k (152-166k) | **0,039** (0,038-0,093) | 5/5 |
| heavy | Claude in Chrome | 6 (5-7) | 21.240 | 289k (226-311k) | 0,154 (0,128-0,205) | 5/5 |
| **debug** | **chrome-bridge** | **6** (4-8) | 4.249 | 284k (167-460k) | **0,091** (0,066-0,144) | 5/5 |
| debug | Claude in Chrome | 31 (21-39) | 37.585 | 1528k (646-2032k) | 0,559 (0,308-0,660) | 4/5 |

Rapporti Claude in Chrome / chrome-bridge sulle mediane:

| compito | turni | token output | cache letta | costo |
|---|---:|---:|---:|---:|
| form | 5,00× | 4,22× | 3,34× | **5,48×** |
| heavy | 2,00× | 3,63× | 1,74× | **3,94×** |
| debug | 5,17× | 4,91× | 5,39× | **6,14×** |

- **Perché chrome-bridge costa un quarto del 29/09** (form da 0,155 a 0,043 $).
  Su win gli hook di avvio non mettono dati variabili nel messaggio per
  sessione, quindi dalla seconda run tutta la prima richiesta (55.342 token)
  si legge dalla cache condivisa e la scrittura iniziale va a 0. Sul
  Chromebook ogni sessione riscriveva circa 27k token di hook e skill. È un
  effetto dell'ambiente e vale per entrambi i bracci. Claude in Chrome però
  riscrive comunque al primo ToolSearch, quindi il rapporto di costo
  **cresce** (form da 2,76× a 5,48×). I due set non sono appaiati fra loro:
  macchina e hook diversi.
- **Quanto pesa la rottura.** Prezzo implicito delle run: 2 $/M input, quindi
  4 $/M per la scrittura 1h e 0,2 $/M per la lettura. I circa 19,3k token
  riscritti costano 0,073 $ in più per run rispetto a rileggerli: il 31% del
  costo di Claude in Chrome su form e il 47% su heavy. Se Claude Code
  correggesse l'ordine del placeholder, a turni invariati il rapporto di costo
  scenderebbe a circa 3,8× su form e 2,1× su heavy.
- La prima run di ogni braccio è a freddo (form bridge 0,254 $), poi il prefisso
  è condiviso.
- I campioni grezzi stanno su win in `D:\workspaces\personali\cb-bench\v302\bench\results`
  e sono copiati in scratchpad. Non sono ancora sul branch `bench-results`.

## Lettura e proposte

1. **«Meno token» regge sulla 2.1.302**: 2-5× meno turni, 3,6-4,9× meno token
   di output e 3,9-6,1× meno costo, a parità di risposte corrette (15/15
   contro 14/15). Va detto però che una parte del rapporto di costo dipende da
   un difetto di Claude Code, la rottura al primo ToolSearch, e non dal
   design di Claude in Chrome. Se Anthropic lo corregge, il costo scende verso
   2-4×. La cifra più robusta da citare sono i turni. Per il costo conviene
   un intervallo con data e versione, non un numero solo.
2. **Le istruzioni MCP non vanno toccate per la cache.** Claude Code le mette
   nella parte per sessione e il server non può cambiarlo. Accorciarle o
   spostarle nelle descrizioni dei tool, che sono nel prefisso condiviso,
   risparmierebbe circa 1,2k token-input equivalenti a sessione: rumore
   rispetto ai 27k del messaggio per sessione.
3. **Il disegno attuale dei tool è quello giusto per la cache e va
   protetto**: core `alwaysLoad` più extra `defer_loading`, con
   `_meta['anthropic/alwaysLoad']`. Sono 0 rotture su 279 caricamenti reali.
   Proposta, non fatta: un test unitario che fallisca se `tools/list` o
   `INSTRUCTIONS` cambiano fra due avvii o contengono data, porta o versione.
   Oggi il determinismo c'è, ma non lo protegge niente.
4. **Argomento pubblico possibile, ora confermato sulla 2.1.302**: «caricare i
   tool di chrome-bridge a metà sessione non invalida la cache del prompt (0
   su 279 caricamenti reali, 0 su 15 nel benchmark); con Claude in Chrome
   succede al primo caricamento, 15 run su 15». Ha una scadenza: vale finché
   Claude Code non corregge il placeholder. Prima di pubblicarlo va riletto
   il changelog. Se lo si vuole usare, va segnalato ad Anthropic come bug
   (ordine di `DeferredToolPlaceholder` nell'array `tools`), non solo usato
   come argomento.
5. **Telemetria**: `mcp_meter` misura i byte dei risultati. Per chrome-bridge
   l'82% dei byte reali sono screenshot in base64, che il modello paga a pixel e
   non a byte. Media 24 KB a chiamata, mediana 266 B. Non va usato come proxy
   dei token senza separare le immagini.
6. **Sul Chromebook la cache si spreca per colpa degli hook, non dei server.**
   Gli hook SessionStart mettono ora e recap nel messaggio per sessione, così
   ogni sessione nuova riscrive circa 27k token che su win si leggono gratis
   dalla cache condivisa. Non è materia di chrome-bridge: va segnalato a
   supervisor e fable-director, che producono quegli hook.

## Riprodurre

- Proxy: script Node di 25 righe. Inoltra ad `api.anthropic.com` e salva il
  corpo delle richieste `/v1/messages`. Serve `ENABLE_TOOL_SEARCH=true` per
  avere il comportamento di prima parte sui tool.
- Rotture: lo script cammina le trascrizioni con la regola del 90% descritta
  nel Metodo. Fa solo letture e costa zero token.
- Serie: `D:\workspaces\personali\cb-bench\run-t302.sh t302 5` su win (Git
  Bash). Chiama `bench/run-series-v2.sh` per ogni braccio e compito, con
  `CHROME_BRIDGE_CAPS=core` e `CIC_DEVICE_ID`. Aggregato:
  `python3 bench/aggregate.py bridge:t302- cic:t302-`. Vedi `bench/RESULTS.md`
  per le regole di inclusione.
- Il controllo del browser in `run-series-v2.sh` va in errore su alcuni stream
  del debug di Claude in Chrome (`AttributeError: 'str' object has no
  attribute 'get'`) e scrive STOP. La serie prosegue lo stesso: lo STOP ferma
  solo quella chiamata. Il browser era quello ammesso, visto nella sonda del
  giro successivo. Da correggere nello script, non fatto qui.
