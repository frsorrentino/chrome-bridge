# Changelog

## 1.15.1 — 2026-07-31

Nata dal collaudo dal vivo della 1.15.0 su ChromeOS: due bugie del reporting
corrette e la finestra che mancava.

- **`move_tab(window_type: "popup")`** — con `new_window` estrae la scheda in una
  finestra popup: niente barra schede, niente omnibox, l'aspetto di una finestra
  terminale. Esiste perché le schede del Terminale ChromeOS staccate finivano in
  finestre browser e l'alternativa vera non c'è: `windows.create` conosce solo
  `normal` e `popup`, le finestre app sono della SWA. Il risultato riporta il
  `window_type` letto da Chrome, non quello richiesto: un declassamento si vede.
  Verificato dal vivo su ChromeOS: tre sessioni terminale in tre popup affiancati
  a terzi esatti del monitor.
- Documentato in `tab_action` quanto verificato dal vivo su ChromeOS: `duplicate`
  funziona dove `create_tab` è vietato (`chrome-untrusted://`) e il duplicato
  nasce **nella finestra della tab sorgente, anche se è una finestra app** — è
  l'unico modo di aprire una nuova sessione Terminal dentro la finestra
  Terminal, visto che `tabs.move` verso una finestra app è rifiutato. Documentato
  anche che `discard` sostituisce l'id della tab: il risultato porta quello
  nuovo, gli id salvati diventano stantii.
- **`viewport_resize` non spaccia più per fallita una mossa riuscita** (commit
  `e0b15ff`): spostava la finestra con `chrome.windows.update` e poi misurava il
  viewport iniettando uno script — che `chrome://` e `chrome-untrusted://`
  rifiutano. La geometria ora viene da `chrome.windows.get` (sempre disponibile)
  e la misura in pagina è best effort: se manca, `viewport_error` dice perché.
  Ne beneficia `window_layout restore`, che falliva su ogni finestra terminale
  salvata come `normal` — esattamente il caso multi-monitor.
- **`manage_downloads action=download` non scambia più un download avviato per
  uno finito** (commit `88ece65`): con "chiedi dove salvare" attivo Chrome tiene
  il file picker aperto e l'API risponde `in_progress` con `filename` vuoto e
  tutti i byte già ricevuti. `classifyDownload` riconosce quella firma come
  `waiting_for_user` col motivo, e il tool ora interroga lo stato reale invece
  di restituire un id e chiamarlo successo.

## 1.15.0 — 2026-07-31

Il progetto multiscreen chiuso end-to-end: la geometria della 1.14.0 diventa
azioni. Un tool nuovo (63, core 34) e quattro capacità come parametri di tool
esistenti — tutte scelte per NON toccare i permessi del manifest, quindi nessun
rischio di revisione lunga sullo store.

### `window_layout`: disposizioni con un nome
`save` fotografa ogni finestra (tipo, stato, bounds, URL delle schede),
`restore` le rimette a posto, `list` e `delete` amministrano. "layout lavoro" =
terminale sul monitor 1, browser affiancati sul 2, un comando.

Tutto lato server, componendo `get_tabs(include_windows)` e `viewport_resize`:
nessun comando nuovo verso l'estensione. Le scelte non ovvie:

- **Gli id delle finestre non sopravvivono al riavvio del browser**: il
  ripristino riconosce le finestre dalla sovrapposizione degli URL delle loro
  schede (Jaccard, a parità di tipo), mai dagli id. Le finestre non
  riconosciute vengono **riportate**, non indovinate.
- **Una finestra da massimizzare riceve solo lo stato**: i bounds verrebbero
  accettati e ignorati, e il confronto richiesto/ottenuto mentirebbe.
- Contro un'estensione < 1.14.0 (che non riporta le finestre) l'errore dice che
  serve l'aggiornamento, invece di fallire su una proprietà mancante — il
  version skew dichiarato che `docs/ANALISI-2026-07-25.md` raccomandava.
- `save` sovrascrive l'omonimo senza chiedere, come `session_fixture`.

### Corsia A: parametri, zero permessi nuovi
- **`create_tab(new_window, left, top, width, height)`** — apre direttamente sul
  monitor scelto: `left` sulla scrivania virtuale è ciò che sceglie lo schermo.
  Prima: aprire e poi spostare, due mosse.
- **`move_tab(new_window, left, top, width, height)`** — estrae una scheda in
  una finestra nuova posizionata via `chrome.windows.create({tabId})`:
  `tabs.move` vuole una finestra che esiste già, questo no. `window_id` diventa
  opzionale; senza né `window_id` né `new_window` l'errore arriva prima del
  round trip.
- **`tab_action: discard | mute | unmute | duplicate`** — `discard` congela una
  tab pesante (WhatsApp/Telegram Web) liberando la RAM: resta nella barra e si
  ricarica al focus. La tmux session dietro un terminale non c'entra: vive nel
  container, non nel renderer.
- **`manage_downloads action=download`** — il permesso `downloads` c'era già e
  veniva usato solo per leggere. Scarica col cookie jar del browser: un file
  dietro login arriva nei Download senza far passare i byte dal bridge.

Verifica: 187 test unit (174 + 13). La prova dal vivo su ChromeOS resta legata
all'arrivo della versione via store o all'estensione unpacked.

Payload `tools/list` core: da ≈8,6k a ≈9,1k token.

## 1.14.0 — 2026-07-31

Il necessario per posizionare le finestre su più monitor. Nessun tool nuovo:
tre parametri su tool esistenti, 62 tool (33 core) invariati.

La scoperta che ha orientato il taglio: le sessioni del Terminale ChromeOS
risultano **già consolidate** in una finestra sola (verificato dal vivo: una
finestra, cinque schede-sessione). Il pezzo mancante non era spostare le schede
— è `move_tab`, che resta per le finestre nuove che garcon apre — ma sapere
**dove stanno le finestre** e metterle dove servono.

### `get_tabs(include_windows: true)`
Prima riportava solo le schede: per decidere dove mettere una finestra si poteva
solo indovinare. Ora aggiunge le finestre con posizione, dimensioni, `state`,
`type`, conteggio schede e un flag **`scriptable`** — dice se la finestra ha
almeno una scheda `http(s)`/`file:`, cioè se `tile_windows` può leggerci l'area
del monitor o serve passargliela. Su una scrivania multi-schermo `left` è ciò
che identifica il monitor.

### `viewport_resize(left, top, state)`
Sapeva ridimensionare, non collocare: su un monitor solo basta, su tre no.
`state` viene applicato **prima** dei bounds — una finestra massimizzata li
accetta e li ignora — e la risposta riporta la geometria reale della finestra
dopo la chiamata, perché il window manager può accettare e non applicare.

### `tile_windows(area)`
L'affiancamento leggeva l'area del monitor da una scheda scriptabile, e le
finestre del Terminale hanno solo schede `chrome-untrusted://`: il caso per cui
il tool era nato restava senza risposta. Con `area` esplicita
(`{left, top, width, height}`) la lettura viene saltata del tutto.

Verifica: 174 test unit. La prova dal vivo su ChromeOS resta da fare: il browser
esegue la 1.11.0 dello store, che non ha nulla di tutto questo — serve
l'estensione unpacked o l'arrivo di questa versione via store.

Payload `tools/list` core: da ≈8,5k a ≈8,6k token.

## 1.13.0 — 2026-07-31

### `tile_windows`: affiancare le finestre su un monitor
Divide l'area utile di uno schermo in parti uguali che non lasciano spazi vuoti.
`layout` fra `grid`, `columns` e `rows`, `padding` opzionale, e la selezione
delle finestre per id o per tipo.

**Solo finestre di Chrome**: un'estensione non può toccare le altre
applicazioni, e su ChromeOS non esiste un'API che glielo permetta.

Su più monitor "lo schermo" non esiste senza dire quale, quindi il monitor si
sceglie indicando una finestra che ci sta sopra (`reference_window_id`, altrimenti
quella con il focus).

Due scelte non ovvie:

- **Nessun permesso nuovo.** La via canonica sarebbe `chrome.system.display`, ma
  è un permesso install-time: su un'estensione già pubblicata significa una nuova
  revisione e il possibile ri-consenso degli utenti installati, per un dato che
  il DOM offre gratis. L'area si legge da `screen.availLeft/availTop/availWidth/
  availHeight` eseguito in una scheda della finestra di riferimento. Il prezzo è
  dichiarato: serve almeno una scheda `http(s)` o `file:` fra le finestre
  bersaglio — le pagine `chrome://` e `chrome-untrusted://` non accettano
  injection — e in mancanza il tool lo dice invece di inventare misure.
- **Il resto della divisione intera viene distribuito, non buttato.** Tre finestre
  su 1000px fanno 333 e avanza 1: scartarlo lascerebbe una striscia di scrivania
  scoperta, cioè esattamente ciò che un affiancamento dovrebbe eliminare. Il resto
  va un pixel per volta sulle prime tessere, quindi le larghezze differiscono al
  massimo di 1px e lo spazio resta pieno. La geometria è una funzione pura in
  `extension/lib/tile-layout.js` con otto test, inclusi sovrapposizioni e
  copertura totale.

Come per `move_tab`, la risposta confronta richiesto e ottenuto (`applied`): il
window manager può accettare una richiesta e ignorarla, e una finestra rimasta
ferma altrimenti passerebbe per affiancata. Le finestre massimizzate vengono
riportate a `normal` prima, perché in quello stato i bounds vengono accettati e
non applicati.

62 tool, 33 core. Il payload `tools/list` del core passa da ≈8,1k a ≈8,5k token.

## 1.12.0 — 2026-07-30

### Pubblicazione sullo store automatizzata
`.github/workflows/publish-extension.yml`: a ogni tag `v*` gira la suite,
verifica che il manifest dica la stessa versione del tag, costruisce lo zip e
chiama `tools/cws-upload.mjs --publish` con le credenziali dai secret del repo.
Motivo: la pubblicazione manuale è stata dimenticata per quattro versioni — lo
store è rimasto alla 1.7.0 mentre il repo arrivava alla 1.12.0. Un compito che si
ricorda è un compito che prima o poi si scorda.

`cws-upload.mjs` ha ora anche `--status` (stato della bozza sullo store) e
`--publish-only`, che serve a distinguere due situazioni che l'API confonde in un
solo messaggio: "in revisione" (si aspetta) e "pronta da pubblicare" (manca solo
la chiamata).

### `move_tab`: spostare una scheda in un'altra finestra
`chrome.tabs.move`. Parametri: `tab_id` e `window_id` obbligatori, `index`
opzionale (default `-1`, in fondo). La scheda non viene ricreata: conserva id,
cronologia e stato della pagina.

Nasce per consolidare le finestre del Terminale ChromeOS, dove garcon apre ogni
sessione in una finestra separata. Il caso che resta **da verificare sul campo**
sono le schede `chrome-untrusted://terminal`: su quello schema
`chrome.tabs.create` è vietato, mentre `move` non crea nulla e potrebbe quindi
essere permesso. Se Chrome rifiuta, l'errore arriva al chiamante **testuale** —
non riscritto, non aggirato: è il dato che si sta cercando, e una parafrasi lo
distruggerebbe.

Due dettagli che il tool dichiara invece di lasciar scoprire:
- entrambe le finestre devono essere normali; Chrome rifiuta lo spostamento
  verso una popup o una finestra di app;
- la risposta porta `same_window`, perché una chiamata accettata che lascia la
  scheda dov'era altrimenti passerebbe per un successo.

61 tool, 32 core. Il payload `tools/list` del core passa da ≈7,9k a ≈8,1k token.

### Invariante sui parametri, ristretta dove vale
`move_tab` è il primo tool con `tab_id` **obbligatorio**: lì non esiste il
contratto del target implicito, e la descrizione deve dire "quale scheda", non
"se omesso vale quella di sessione". Il test che pretendeva un testo unico per
`tab_id` ora confronta solo le occorrenze opzionali, e ne è stato aggiunto uno
che vieta di promettere un default su un parametro che non si può omettere.

## 1.11.1 — 2026-07-30

Solo testi. Il changelog della 1.11.0 diceva "cinque capacità **prese da**" un
altro progetto: dichiarava più di quanto fosse successo. Quel che è passato sono
decisioni di progettazione — nessun codice: il confronto riga per riga del
renderer markdown dà **zero righe significative identiche** su 40 e 73, contro un
substrato diverso (API dell'estensione contro CDP). Su tre punti l'implementazione
fa l'opposto: albero percorso per blocchi invece di selettore piatto, intestazioni
vere invece di segnaposto, troncamento dichiarato invece che silenzioso.

Il perché tecnico resta dov'era: i tre difetti dei renderer DOM→markdown sono
ancora fissati come test, e la ragione per cui `save_to` è opt-in per chiamata
invece che automatico è ancora scritta.

Nessun cambiamento funzionale. L'estensione è identica alla 1.11.0 a meno del
numero di versione, quindi **non viene ricaricata sul Chrome Web Store**: lì la
1.11.0 è in review, e sostituirla azzererebbe l'attesa senza cambiare una riga di
ciò che gira nel browser.

## 1.11.0 — 2026-07-30

Cinque capacità che mancavano, tutte come **parametri di tool esistenti** e
nessun tool nuovo: `Tool Count` 2/5 è l'unico rilievo Glama stabile su tre
misurazioni, e nessuna di queste lo giustificava.

### `click` con tasto destro e doppio click
`grep -c "dblclick\|contextmenu" extension/service-worker.js` restituiva **0**.
Ora `button: 'right'` emette `contextmenu` — i menu contestuali delle pagine lo
ascoltano, quello nativo del browser no da un evento sintetico — e `count: 2`
emette `dblclick` dopo i due click, che è ciò che seleziona una parola o apre un
editor inline. `dblclick` non è implicito nei due click: va emesso a parte.

### `wait_for` attende un testo
`condition: 'text'`. Si poteva già fare con `condition: 'function'`, ma quella
strada richiede il toggle "Allow user scripts" e un'espressione scritta a mano.
Restituisce anche il contesto attorno alla prima occorrenza, per confermare di
aver trovato la cosa giusta senza restituire la pagina.

### `viewport_resize` sa leggere
`action: 'get'` riporta il viewport senza ridimensionare. Toglie la toppa che la
descrizione del tool stesso ammetteva: *"measure it with execute_js if the exact
number matters"*.

### `read_page(mode: 'markdown')`
Struttura preservata a una frazione del costo di `html`. L'idea è loro,
l'implementazione no — la loro ha tre difetti che qui sono test:

- il selettore piatto include sia `a` sia `li`, quindi `<li><a>x</a></li>` esce
  **due volte**; qui l'albero è percorso per blocchi;
- le tabelle sono troncate a 10 righe × 3 colonne con un'intestazione finta
  `| Table Content |` che butta via gli header veri; qui gli header sono quelli
  della pagina, il cap è 50 righe e viene **dichiarato**, con il rimando a
  `extract_table` e al suo filtro server-side;
- taglio secco a 50.000 caratteri senza dirlo.

Preso invece tale e quale il loro trattamento delle immagini: sommario di quante
sono ≥100×100, riferimenti inline per quelle ≥50×50 con le dimensioni, icone
sotto soglia scartate.

### `save_to` su `read_page`, `extract`, `screenshot`
Il payload va su disco e nel contesto resta il percorso più un sommario. Loro lo
fanno automaticamente a ogni azione, scrivendo quattro file; qui è opt-in per
chiamata, perché scrivere file per chi non li leggerà è una tassa, e
chrome-bridge non controlla la session dir del client.

### Costo
60 tool, 31 core, invariati. Il payload `tools/list` del core passa da ≈7,6k a
≈7,9k token. `save_to` e `markdown` servono a restituirne molti di più di quanti
ne costino, sulle pagine grandi.

## 1.10.1 — 2026-07-30

### Gli ultimi cinque tool sotto la A
`type_text`, `wait_for`, `highlight_elements`, `session_fixture`,
`viewport_resize`. Ogni riscrittura corregge il difetto che l'audit citava, e
ogni affermazione aggiunta è stata verificata nel sorgente, non dedotta:

- **`wait_for` su timeout non solleva**: restituisce `found: false` con una
  ragione (`service-worker.js:1453`). Non era scritto da nessuna parte, e un
  chiamante che ignora il campo procede come se l'attesa fosse riuscita. Ora la
  descrizione porta anche i default reali: 10s per element e function, 15s per
  navigation e network_idle.
- **`type_text` sostituisce, non accoda**, assegna attraverso il setter nativo
  perché gli input controllati di React registrino il cambio, e poi emette
  `input` e `change`. `mode=keys` emette invece keydown/input/keyup per
  carattere: serve ad autocomplete e campi mascherati.
- **`session_fixture` ha un'azione `list`** che non era mai stata nominata. E
  `save` sovrascrive senza chiedere, mentre `restore` scrive sopra ciò che c'è
  invece di azzerare prima.
- **`viewport_resize` ridimensiona la finestra, non il viewport**: quello
  renderizzato resta più piccolo dell'altezza della barra del browser. `width` e
  `height` sovrascrivono ciascuno la propria metà del preset.
- **Gli overlay di `highlight_elements` sono nodi DOM iniettati**: un reload li
  perde, e ogni chiamata azzera quelli precedenti invece di accumularli.

`test/unit/tool-descriptions.test.js` verifica che questi cinque fatti restino
nelle descrizioni: sono i comportamenti che cambiano l'esito di una chiamata.

Costo: il payload `tools/list` del core passa da ≈7,4k a ≈7,6k token.

### Nota su cosa NON è stato inseguito
`Server Coherence` di Glama è passata da A a C fra due release senza che un
singolo tool cambiasse nome: `Naming Consistency` da 5/5 ("No mixing of
conventions") a 2/5 ("Tool names lack a consistent pattern"), `Tool Count` da 3/5
"justified by the broad scope" a 2/5 "excessively large" con gli stessi 60 tool.
È un giudizio LLM rigenerato a ogni release, con varianza di tre punti su cinque
a input costante. Le azioni che chiederebbe — rinominare tool pubblici,
cancellarne di utili — danneggerebbero un'estensione con utenti installati per un
numero che si muove da sé. Non è stato inseguito, e non va inseguito.

## 1.10.0 — 2026-07-30

### Ogni parametro documentato: copertura da 35% a 100%
L'audit di Glama misura la dimensione `Parameters` come copertura letterale dei
`.describe()`: su `http_auth`, *"three parameters with 0% description coverage"*,
voto 1/5. Erano 88 parametri descritti su 254, con 17 tool a copertura zero.
Ora sono 254 su 254.

Non è prosa aggiunta per far numero: lo schema JSON dichiara la struttura (tipo,
enum, default) ma non l'intento. `selector` non diceva che `">>>"` perfora lo
shadow DOM, `tab_id` non diceva cosa succede se lo ometti, `set_storage.action`
non diceva che `clear` ignora `key` e cancella tutto. Sono le informazioni per
cui l'agente spendeva una chiamata in più.

`tab_id` e `frame_id` compaiono in 54 e 12 tool: hanno un testo unico condiviso, e
`test/unit/tool-parameters.test.js` fallisce se divergono — oltre a fallire se un
parametro qualsiasi non ha descrizione, o se una descrizione supera 130 caratteri
(la stessa rubrica pesa la concisione).

### Confini fra tool gemelli, dopo una regressione
La 1.9.0 ha fatto scendere `Disambiguation` da 5/5 a 4/5, e la causa era nostra:
avevo messo rimandi incrociati ("per le tabelle usa extract_table", "per CLS usa
web_vitals") che hanno reso visibile una vicinanza fra tool prima non notata.
Ora ognuno dichiara il proprio confine invece di delegarlo al gemello:
`screenshot` è il solo viewport, `element_screenshot` il ritaglio più economico,
`get_performance` copre "quanto è arrivato veloce il documento",  `web_vitals`
"quanto è stabile e reattivo dopo il load", `extract_table` il markup tabellare,
`extract` le strutture ripetute non tabellari.

Il rimando da `read_page` a `extract_table` resta: quello previene l'errore da
50.070 byte contro 236 documentato in `bench/RESULTS.md`, e vale più di un punto
di rubrica.

### Costo, dichiarato
Il payload `tools/list` del set core passa da ≈5,7k a ≈7,4k token, ed è quasi il
doppio dei ≈3,8k della 1.8.0. Sul benchmark `form` sono circa +8% di cache read
per turno. Il vantaggio misurato non è mai stato la dimensione del prefisso ma il
numero di turni (2,75×); il README ora riporta entrambi i numeri e dice che sulla
sola dimensione del prefisso Playwright MCP è più snello.

## 1.9.0 — 2026-07-30

### `http_request` — richieste HTTP con i cookie dell'utente
La fetch parte dal service worker dell'estensione con `credentials: 'include'`,
quindi porta la sessione dell'utente: scarica fatture, JSON e export CSV da
portali autenticati, dove la stessa richiesta fatta dal server Node riceve la
pagina di login. Con `save_to` i byte vanno su file invece che nel contesto — è
anche il modo di leggere un PDF, che Chrome apre in un viewer dove nessun content
script entra (su una tab PDF `read_page` restituisce
`Cannot access a chrome-extension:// URL of different extension`).

### `navigator.userAgent` emulabile
`emulate_media` accetta `user_agent` e sovrascrive `navigator.userAgent`,
`appVersion` e `platform` nel MAIN world. Copre metà del problema per scelta
dichiarata: l'header della richiesta si cambia già con
`network_rules(action=modify_header)`, e ora la descrizione lo dice invece di
lasciar credere all'agente di aver cambiato entrambi. Nessun tool nuovo: stesso
meccanismo e stesso `reset` delle altre emulazioni.

### Nessun tool nuovo per i cookie: c'erano già
L'audit Glama segnalava "missing dedicated cookie management". Falso negativo:
`get_storage` legge i cookie (`type: 'cookies'`, con flag e scadenze) e
`set_storage` li scrive con path, domain ed expires. Non mancava la funzione,
mancava nella descrizione — corretto.

### 12 descrizioni riscritte
Le nove sotto 3.0/5 nell'audit Glama più `get_tabs`, `create_tab` e
`full_page_screenshot`. `read_page` era "Read the content of a Chrome tab page":
37 caratteri, mentre le istruzioni del server avvertono che su una tabella grande
costa decine di migliaia di token — un avviso che l'agente legge una volta
all'inizio e non nel momento in cui sceglie. Ora ogni descrizione dice cosa
cambia, cosa non è persistito e quando conviene un altro tool.
`test/unit/tool-descriptions.test.js` fissa un pavimento di 60 caratteri e
verifica che i tool distruttivi e quelli costosi lo dichiarino in prosa.

### Conteggio e costo, misurati
60 tool (31 core). Il payload `tools/list` del set core passa da ≈3,8k a ≈5,7k
token: ≈784 dalle annotations, il resto dalle descrizioni. È un aumento voluto —
il vantaggio misurato sta nei turni (2,75×), non nella dimensione del prefisso —
ma ribalta il confronto sugli schemi con Playwright MCP (≈4,6k a luglio 2026),
e il README ora lo dice invece di citare il numero vecchio.

### Annotations MCP su tutti i 60 tool
Nessun tool le dichiarava (erano 59 prima di `http_request`). Sono l'unico modo che l'agente ha di sapere cosa fa
un tool al mondo *prima* di chiamarlo: senza `readOnlyHint`, `click` e
`read_page` si equivalgono al momento della scelta. Ora ogni tool dichiara tutti
e quattro gli hint, da una tabella sola (`TOOL_ANNOTATIONS`) applicata dallo
stesso wrapper che filtra le capability — se fossero state aggiunte solo al ramo
`caps === 'all'`, con `--caps core` (il default di chi installa) sarebbero
sparite in silenzio.

`destructiveHint: true` è riservato a ciò che distrugge davvero: `tab_action`
(chiude una tab dell'utente), `set_storage` e `session_fixture` (sovrascrivono
cookie e storage), `save_page` (sovrascrive un file), `read_console` con
`clear:true` (cancella il buffer), `execute_js` (codice arbitrario).

Costo misurato sul payload `tools/list`: +784 token con `caps=core` (+18,9%),
cioè +1,9% della componente cache read del benchmark `form`. La variante
"emetti solo i valori diversi dal default dello spec" risparmierebbe 173 token
ma lascerebbe `annotations: {}` proprio su `execute_js` e `tab_action`, il cui
profilo coincide con i default — indistinguibile da nessuna annotation. Scartata:
un turno di quel benchmark costa ~41,5k di cache read, quindi una sola scelta di
tool evitata ripaga l'overhead ~8,8 volte.

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
