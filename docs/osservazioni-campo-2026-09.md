# Osservazioni dal campo, settembre 2026

Raccolta delle osservazioni che arrivano dalle sessioni che usano chrome-bridge su progetti reali, con il triage di ciascuna e il piano di correzioni. Le nuove osservazioni si aggiungono in fondo alla tabella «Registro», con fonte e data.

Classi:
- **D**: difetto nostro, da correggere.
- **L**: limite di Chrome, di ChromeOS o del client MCP. Si documenta.
- **S**: comportamento del sito. Non è nostro: al massimo un consiglio nella skill.

Codice citato allo stato di `4de3bfd` (1.18.0).

## Fonti

1. med-systems-it, Meta Ads Manager, Gestione eventi e landing, 22 e 23/09: `~/.claude-pixel/projects/-home-franz-Desktop-workspaces-pixelfarm-clienti-med-systems-it/memory/chrome-bridge-osservazioni.md`, 20 punti (qui M1…M20).
2. francescosorrentino-com, 23/09: memoria `lighthouse-macchina-lenta.md` del progetto (qui F1, F2).
3. Già risolti in 1.18.0: `execute_js` con `timeout` e `save_to`, `get_tabs` con `closed_session_tabs`.

## Triage

| # | Osservazione | Classe | Prova |
|---|---|---|---|
| M1 | Scheda in finestra nascosta: la pagina non disegna, `setInterval` fermi, screenshot `timed out after 10000ms` o `image readback failed` | **L** + **D** | L: Chrome non produce frame per le finestre occluse o minimizzate e rallenta i timer delle pagine `hidden` (dopo 5 minuti, un risveglio al minuto). D1: `SCREENSHOT_TIMEOUT_MS = 10000` (`server/protocol.js:100`) è uguale al timer interno di `captureVisible` (`extension/service-worker.js:600`), che parte dopo il pacer da 520 ms. Vince sempre il timeout di trasporto, col messaggio generico «the tab may be busy», e il messaggio utile («window is not rendering frames») non arriva mai. D2: nessun tool riporta `document.visibilityState`, quindi chi chiama lo scopre solo dopo tre attese fallite. `image readback failed` passa così com'è, senza spiegazione. |
| M2 | `move_tab new_window` lascia la pagina `hidden`; poi `tile_windows` dice `Finestra di riferimento 483581640 non trovata` | **L** + **D** minore | `cmdMoveTab` (`service-worker.js:1156`) chiama `windows.create({tabId})` senza `focused` e non rilegge la visibilità. La nuova finestra può nascere dietro la finestra app del Terminale: il fuoco lo decide il window manager di ChromeOS. Gli id delle finestre Chrome non cambiano, e 483581640 non è l'id restituito da `move_tab` (483581370): è un id vecchio o di un'altra finestra. D: il `move_tab` non dice `visibility`, e l'errore di `tile_windows` non elenca le finestre esistenti. |
| M3 | `navigate` su una scheda chiusa: `No tab with id` | già risolto | 1.18.0: motivo della chiusura (`tabEndings`) e `closed_session_tabs`. |
| M4 | `[media removed: request limit]` sugli screenshot | **L** (client) | La stringa non esiste nel nostro codice (`grep` su server ed estensione): la scrive il client Claude Code quando una richiesta porta troppe immagini. Rimedio lato nostro: consigliare `save_to` ed `element_screenshot` con `region` e `scale`. |
| M5 | Tabella Ads Manager virtualizzata in orizzontale; export CSV non scarica | **S** | La virtualizzazione è del sito. Export: non riprodotto, probabilmente legato a M1 (scheda nascosta). Da riverificare con la scheda visibile prima di classificarlo. |
| M6 | Breakdown età/genere solo per la prima inserzione | **S** | Comportamento di Ads Manager. |
| M7 | `find_text` non trova «Prestazioni e clic»; `Unknown ref n47 — run get_interactives first` | **D** (due difetti) | D3: `cmdFindText` (`service-worker.js:3534`) cerca dentro il **singolo nodo di testo**. Un'etichetta divisa in più nodi (evidenziazioni, `&nbsp;`, span annidati, come fa Meta) non viene mai trovata. Non guarda neanche dentro gli shadow root. D4: la mappa dei ref è **una sola per scheda** e ogni chiamata di scoperta la **sostituisce** ripartendo da `n1`: `get_interactives` (`server/tools.js:2209`), l'anteprima di `navigate` (`:525`) e i «near» di `find_text` (`:1510`). Dopo un `find_text`, `n47` sparisce; peggio, `n3` resta valido ma punta a un **altro elemento**. Il click va a segno sull'elemento sbagliato senza errori. Il messaggio d'errore suggerisce `get_interactives` anche quando il ref veniva da `find_text`. |
| M8 | Listbox età virtualizzata: «30» non compare con tasti né con `scroll until` | **S** + D5 | La virtualizzazione è del sito; che l'opzione compaia solo alla chiamata dopo è normale (il sito disegna al frame successivo). La parte `scroll until` è D5 (vedi M17). |
| M9 | `type_text` sul date picker: `mismatch:true, value_after:""` | **L** + **D** probabile | L: gli eventi sintetici hanno `isTrusted:false`, e senza il permesso `debugger` l'estensione non può produrre input veri. D6: la modalità `keys` (`service-worker.js:907`) non manda `beforeinput` e scrive il valore col setter. Esiste una via più vicina all'input reale senza `debugger`: `focus()` più `document.execCommand('insertText')`. Chrome genera `beforeinput` e `input` con `isTrusted:true`, e gli editor controllati (React, Lexical) di solito li accettano. Da verificare dal vivo su Meta prima di promettere. Il `mismatch` riportato è già corretto: ha evitato un falso successo. |
| M10 | Budget: senza Enter il valore non viene preso | **S** | Il campo salva su `keydown Enter`. Un consiglio nella skill. |
| M11 | Più click sintetici nello stesso `execute_js`: 1 su 3 applicato | **S** | Re-render di React fra un click e l'altro. Consiglio: una chiamata per click, o `setInterval` a 350 ms. |
| M12 | Dialog «Esamina le bozze»: Pubblica resta grigio | **S** | Stato del sito; la modifica risulta pubblicata al reload. |
| M13 | `click` su voce di menu: `occluded:true` con occluder il dropdown stesso; la voce non viene selezionata; `force:true` funziona | **D** probabile, da riprodurre | Il controllo (`service-worker.js:827`) scarta l'occlusione solo se occluder e bersaglio sono uno dentro l'altro. Uno strato trasparente fratello dentro lo stesso menu risulta un occluder, anche se il click arriva comunque al menu. Rimedio possibile: se occluder e bersaglio stanno sotto lo stesso contenitore `[role=menu|listbox|dialog]` o lo stesso layer, cliccare e riportare `occluded_by_sibling`. Prima serve un caso riprodotto. Sul filtro con `mode:set` che non parte vedi M9. |
| M14 | Ricerca luoghi: `type_text mode:keys "Lazio"` dà «Nessuna corrispondenza» | **L** + D6 | Come M9: il tokenizer di Meta scarta l'input sintetico. È il banco di prova di D6. |
| M15 | `get_interactives scope` con `[role="menu"], [role="dialog"]` dà 0 | **S** | Meta non mette `role` ai suoi menu, quindi lo scope non corrisponde a nulla. Non è nostro, ma un consiglio evita il giro: con `scope` a 0, provare `find_text` sul testo della voce (dopo D3). |
| M16 | `wait_for condition:text` con 25 s esce a `timed out after 60000ms` | **D** | D7: `cmdWaitForText` (`service-worker.js:4447`) fa il polling **dentro la pagina** con `setTimeout`. Su una scheda nascosta Chrome raggruppa i timer al minuto, quindi il controllo delle 25 s scatta tardi e vince il timeout di trasporto (`getTimeout` = 60000, `protocol.js:149`). Lo stesso schema c'è in `wait_for element` e in `scroll until`. Rimedio: la scadenza la tiene il service worker (un `executeScript` breve per ogni giro, oppure `Promise.race` con un timer del service worker), e il risultato dice `found:false, page_hidden:true`. |
| M17 | `scroll action:until` su Ads Manager: `finalScrollY:0, stopped_reason:bottom` | **D** | D5: `cmdScrollUntil` (`service-worker.js:4710`) scorre solo `window`. Se il documento non scorre, la condizione «bottom» è vera al primo giro. Rimedio: parametro `container` (selettore), e in sua assenza scegliere da solo il contenitore scorrevole più grande quando `document` non scorre; il risultato dice quale ha usato. |
| M18 | «Testa eventi» apre un popup con `window.open('', '_blank')`: la scheda naviga via | **S** | Comportamento del sito. Consiglio già provato: sovrascrivere `window.open`. |
| M19 | `screenshot presets:["mobile"]` restituisce un viewport 2226×1083 | **D** + **L** | L: senza il permesso `debugger` non c'è emulazione del dispositivo; `presets` ridimensiona la **finestra**, e il window manager impone una larghezza minima e può ignorare la richiesta. D8: il tool etichetta l'immagine `mobile` anche quando il viewport è rimasto desktop. Il ramo `presets` (`server/tools.js:640`) non confronta viewport ottenuto e richiesto. Rimedio: se la larghezza ottenuta supera di molto quella del preset, niente immagine etichettata `mobile`, ma una nota esplicita (`not applied: viewport 2226 px`). Il 2226 su uno schermo da 1536 indica anche uno zoom della pagina sotto il 100%: va riportato (`chrome.tabs.getZoom`). |
| M20 | `sleep 45` bloccato dal PreToolUse | fuori ambito | Hook del sistema, non del bridge. |
| F1 | Viewport massimo 1536×686 su schermo 1536×864 | **L** | Lo schermo meno lo scaffale di ChromeOS e la barra delle schede. Una finestra non può superare lo schermo: per un viewport 1440×900 serve un browser headless. |
| F2 | Con i soli tool `core`, niente emulazione del telefono | **L** + documentazione | Come M19. Né `viewport_resize` né `emulate_media` stanno in `core` (`server/tools.js:226`, gruppo `visual`), e nessuno dei due emula un telefono (DPR, UA, touch). Va scritto nel README e nella descrizione di `presets`. |

## Piano di correzioni

Ordine per impatto diviso per costo. S = mezza giornata o meno, M = una giornata.

| Ordine | Difetto | Impatto | Costo | Cosa cambia | Verifica |
|---|---|---|---|---|---|
| 1 | D4 ref sovrascritti | **Alto**: click sull'elemento sbagliato senza errori | S | Numerazione dei ref che cresce e non si azzera per scheda (`n1`… mai riusati), mappa cumulativa con tetto (es. 500, i più vecchi escono). La chiave della mappa passa dall'id reale della scheda: oggi `tab_id` esplicito e `tab_id` omesso possono finire in chiavi diverse (`refsKey`, `tools.js:479`). L'errore dice da quale chiamata viene l'ultimo lotto di ref. | Test unitario: get_interactives, poi find_text, poi click `n47` risolve il selettore originale; `n3` non cambia significato. |
| 2 | D7 wait_for oltre il timeout | Alto: 35 s persi per chiamata, e un messaggio che fa pensare alla scheda bloccata | S | Scadenza tenuta dal service worker per `wait_for text/element` e `scroll until`; il risultato dice `page_hidden` quando la pagina è `hidden`. | e2e: scheda in finestra minimizzata, `wait_for text` con 3 s: risposta entro 4 s con `found:false, page_hidden:true`. |
| 3 | D1 e D2 screenshot e visibilità | Alto su ChromeOS: è il blocco più frequente di M1 | S | Timeout di trasporto dello screenshot a 15 s, così arriva il messaggio interno. `image readback failed` tradotto nello stesso messaggio. `visibility` (`visible`/`hidden`) nel fingerprint di pagina, in `get_page_info` e nel risultato di `move_tab`. | e2e con finestra minimizzata: il messaggio contiene «not rendering frames»; `get_page_info` riporta `hidden`. |
| 4 | D3 find_text | Medio-alto: sui siti con etichette spezzate il tool non serve | S | Ricerca sul testo normalizzato dell'elemento (spazi, ` `) invece che del singolo nodo, restituendo l'elemento più interno che contiene tutto il testo; attraversamento degli shadow root aperti. | Fixture: `<li><span>Prestazioni</span> e <b>clic</b></li>` e `Prestazioni&nbsp;e clic` trovati; nessun doppione per gli antenati. |
| 5 | D5 scroll until nel contenitore | Medio | S | Parametro `container`; scelta automatica del contenitore scorrevole quando `document` non scorre; `container` nel risultato. | Fixture con `body{overflow:hidden}` e `div` scorrevole: `stopped_reason` diverso da `bottom` al primo giro, `scrollTop` cresciuto. |
| 6 | D8 presets non applicati | Medio: un'immagine desktop etichettata `mobile` porta a conclusioni sbagliate | S | Confronto fra viewport ottenuto e richiesto, zoom della pagina nel risultato, nota `not applied` invece dell'etichetta. Descrizione di `presets` che dice «ridimensiona la finestra, non emula». | Test unitario sul ramo `presets` con viewport simulato 2226. |
| 7 | D6 `type_text` più vicino all'input reale | Medio, incerto: dipende dal sito | M | Nuova modalità (o nuovo comportamento di `keys`) con `focus()` e `execCommand('insertText')`, e ripiego sull'attuale se il valore non cambia. | Dal vivo su Ads Manager (ricerca luoghi «Lazio», date picker) con l'ok di Franz e la scheda visibile. Se non passa, il punto resta L e si documenta. |
| 8 | Occlusione fra fratelli (M13) | Basso-medio | S, dopo la riproduzione | Solo dopo un caso riprodotto in una fixture. | Fixture con strato trasparente fratello nel menu. |
| 9 | Errore di `tile_windows` (M2) | Basso | S | Il messaggio elenca gli id delle finestre esistenti e quella che contiene la scheda di sessione. | Test unitario sul messaggio. |

Da 1 a 6 stanno in una minor (1.19.0). Il 7 si fa solo se la prova dal vivo riesce. Release e push solo con l'ok di Franz.

## Punti di documentazione

Una frase ciascuno, dove evita un giro a vuoto.

Istruzioni del server (`server/index.js`, lette a ogni sessione):
- «A tab in a hidden, minimized or fully covered window does not render: screenshots time out and page timers slow to one per minute. Check get_page_info visibility first; bring the window on screen or create_tab new_window with bounds.» (M1, M2, M16)

README, sezione limiti:
- La finestra nascosta, con la stessa sostanza e il perché (Chrome non disegna e rallenta i timer).
- `presets` ed emulazione: ridimensionano la finestra, non emulano un telefono; la larghezza minima e lo schermo pongono un tetto (es. 1536×686 su uno schermo 1536×864); per viewport più grandi o per il telefono serve un browser headless. (M19, F1, F2)
- Gli eventi sintetici hanno `isTrusted:false`: alcuni campi (date picker, ricerche con tokenizer) li scartano. Controllare `mismatch` nel risultato di `type_text`. (M9, M14)
- `[media removed: request limit]` è un limite del client: usare `save_to` o `element_screenshot` con `scale`. (M4)

Skill `chrome-bridge` (ricette):
- Siti con menu senza `role` (Meta): `find_text` sul testo della voce, non `get_interactives scope` per ruolo. (M15)
- Liste virtualizzate: scorrere il contenitore in una chiamata, cliccare nella successiva. (M8)
- Più click su un'interfaccia React: una chiamata per click, oppure un intervallo di circa 350 ms fra l'uno e l'altro. (M11)
- Campi che salvano su Enter: `type_text` e poi `press_key Enter`. (M10)
- Popup aperti con `window.open('')`: sovrascrivere `window.open` prima del click. (M18)

## Registro

| Data | Fonte | Punti | Stato |
|---|---|---|---|
| 2026-09-23 | med-systems-it (Meta) | M1–M20 | via di Franz alle 15:03 per i punti 1-6 e la documentazione: implementati, unitari 327/327, e2e in launch mode 39/39. Restano da provare dal vivo: 7 (`execCommand`), 8 (occlusione); 9 non richiesto |
| 2026-09-23 | francescosorrentino-com | F1, F2 | triage fatto, solo documentazione |
