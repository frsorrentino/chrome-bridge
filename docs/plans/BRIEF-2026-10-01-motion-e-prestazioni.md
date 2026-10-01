# Brief: misure di movimento e prestazioni in chrome-bridge (01/10/2026)

Richiesta di Franz, 01/10/2026: integrare in chrome-bridge «tutti i tool» che oggi mancano rispetto a chrome-devtools-mcp, senza usare un secondo MCP. chrome-devtools-mcp è stato provato come ponte e rimosso alle 17:18.

Il motivo è il plugin di metodo per il movimento web in preparazione, con pilota sul lotto D3 di francescosorrentino.com. Per verificarne le animazioni servono misure che chrome-bridge oggi non dà. Contesto: `personali/docs/ricerche/design-motion-web-2026-10-01.md`. Il bisogno è già registrato in `francescosorrentino.com/docs/redesign/limiti-chrome-bridge.md`, voce 1.

Brief scritto dalla sessione `video-chrome-bridge-v2`. È una proposta: piano, nomi e tagli li decide la sessione di chrome-bridge, insieme a Franz.

## Punto di partenza (letto nel codice, 1.26.0)

- **Il debugger.** L'estensione ha già il permesso `debugger`. Lo usa solo su richiesta, per l'input fidato (`extension/lib/trusted-input.js`: aggancio, `sendCommand`, sgancio). L'aggancio mostra all'utente la barra «sta eseguendo il debug del browser»: per questo resta su richiesta.
- **La modalità launch.** `server/launcher.js` apre un Chromium dedicato, anche headless. È il posto naturale per le misure pesanti, senza la barra sul Chrome dell'utente.
- **Strumenti già presenti:**
  - `audit` (accessibilità e SEO);
  - `get_css_styles`, che usa `CSS.getMatchedStylesForNode` quando c'è il debugger;
  - `monitor_network`, `screenshot_diff`;
  - visibilità della scheda in `get_page_info`;
  - gruppi di tool attivabili con `get_status({enable})`.
- **Nessun permesso nuovo** serve per quanto segue: niente nuovo riesame dello Store per i permessi.

## I tool da aggiungere

Mappa per gruppo: chrome-devtools-mcp a sinistra, chrome-bridge a destra. Tutti nel gruppo opzionale nuovo `perf`, salvo dove indicato.

| # | Funzione | Come | Debugger | chrome-devtools-mcp |
|---|---|---|---|---|
| 1 | **`animations`**: le animazioni in corso. Per ognuna l'elemento (selettore e ref), le proprietà, la durata, il ritardo, la curva, le iterazioni, lo stato, il tipo di timeline (documento, scroll, view) e se è una View Transition. «Composta» è una stima: solo `transform`, `opacity`, `filter` e simili. Va scritto che è una stima | script nella pagina, `document.getAnimations()` e `effect.getKeyframes()`/`getComputedTiming()` | no | assente (lì si usa `evaluate_script`) |
| 2 | **`frames`** (o un'opzione di `animations`): registra per N ms i fotogrammi lunghi (Long Animation Frames: durata, `blockingDuration`, `renderStart`, `styleAndLayoutStart`, gli script responsabili), i salti di layout (CLS con l'elemento) e l'INP delle interazioni avvenute nella finestra. Opzione: esegue un'azione (clic, scroll, hover) all'inizio della registrazione | PerformanceObserver `long-animation-frame`, `layout-shift`, `event` con `buffered`; attribuzione come `web-vitals/attribution` (riscritta, non la libreria) | no | in parte, dentro i trace |
| 3 | **`emulate`**, esteso o nuovo: `prefers-reduced-motion`, `prefers-color-scheme`, `prefers-contrast`, CPU rallentata (fattore), rete (profili), viewport con DPR, touch e mobile | `Emulation.setEmulatedMedia`, `Emulation.setCPUThrottlingRate`, `Network.emulateNetworkConditions`, `Emulation.setDeviceMetricsOverride`, `Emulation.setTouchEmulationEnabled` | sì | `emulate`, ma senza reduced-motion: lo aggiungiamo noi |
| 4 | **`perf_trace`** start/stop, con analisi: LCP con la sua scomposizione, INP, CLS, documento lento, risorse che bloccano il rendering, fotogrammi lunghi. Il trace grezzo va su file; il risultato riporta solo le conclusioni | dominio CDP `Tracing`; analisi con il motore dei trace di DevTools (pacchetto npm del team Chrome, lo stesso che usa chrome-devtools-mcp: verificare nome, licenza e peso) | sì | `performance_start_trace`/`stop_trace`/`analyze_insight` |
| 5 | **`screencast`** start/stop: cattura video della pagina in .mp4/.webm, con fps e scala | `Page.startScreencast`, fotogrammi con il loro tempo, montati da ffmpeg lato server (se ffmpeg manca, cartella di JPEG più la riga di comando) | sì | `screencast_*`, sperimentale e dietro opzione |
| 6 | **Lighthouse completo**, prestazioni comprese, solo in modalità launch | CLI `lighthouse` contro la porta di debug del Chromium lanciato; il risultato in sintesi, il report su file | no (porta CDP del launch) | `lighthouse_audit`, che lì esclude le prestazioni |
| 7 | **`heap_snapshot`**, opzionale e da valutare: istantanea, sintesi per classe, confronto fra due istantanee | `HeapProfiler.takeHeapSnapshot` in streaming su file; analisi lato server | sì | 14 tool `*_heapsnapshot` |

**Fuori, salvo diversa decisione di Franz:** estensioni e PWA (5 + 4 tool lì), WebMCP e terze parti (`Third-party`). Non servono al lavoro sui siti.

## Regole di progetto

- **Il debugger è «su richiesta», come l'input fidato.**
  - I tool 3, 4, 5 e 7 lo agganciano solo quando sono chiamati e lo sganciano alla fine, o allo stop per le registrazioni.
  - La descrizione del tool dice della barra gialla.
  - In modalità launch la barra non disturba nessuno: consigliarla nella descrizione.
- **Prima tappa: la prova dei domini.** Verificare con una chiamata reale che `chrome.debugger` dall'estensione accetti `Tracing`, `Emulation`, `Page.startScreencast` e `HeapProfiler`, sia sul Chrome di Franz sia in modalità launch. Un dominio rifiutato sposta il suo tool sulla sola modalità launch (porta CDP diretta) e lo dichiara.
- **Uscite brevi.** Conclusioni, conteggi e percorsi, mai dump. I trace e i video vanno su file, e il risultato riporta il percorso e la dimensione. Stesso principio di `extract_table`.
- **Riduci movimento.** `emulate` più `animations` permettono di verificare che con `reduce` restino solo dissolvenze brevi. Va aggiunto un esempio in `assert`, se si integra bene.
- **Scheda nascosta.** rAF e osservatori si fermano su una scheda nascosta (`limiti-chrome-bridge.md` voce 2). `frames`, `screencast` e `perf_trace` devono rifiutare o avvisare quando la pagina è nascosta.
- **Gruppo `perf` opzionale**, attivato con `get_status({enable:["perf"]})`: non pesa sui token sempre caricati.

## Tappe proposte

1. **Senza debugger:** `animations` e `frames`. Sono le più utili per il movimento e non hanno costo di privacy. Test sulle pagine demo di `bench/` più una pagina con animazioni CSS, WAAPI, scroll-driven e View Transition.
2. **Emulazione:** il tool 3, con reduced-motion verificato da `animations`.
3. **Registrazioni:** `perf_trace` e `screencast`, prima in modalità launch, poi su richiesta sul Chrome dell'utente.
4. **Lighthouse completo** in launch; `heap_snapshot` solo se Franz lo conferma.

Ogni tappa ha i suoi test, `TOOLS.md`, `CAPABILITIES.md`, il conteggio dei tool aggiornato nel README e il CHANGELOG. Release, Store e npm solo con l'ok finale di Franz.

## Verifica del risultato

- **Su francescosorrentino.com** (lotto D3, locale):
  - `animations` elenca le molle `--spring`/`--settle` del sito con le curve `linear()`;
  - `frames` su un'interazione del palco riporta zero fotogrammi lunghi oltre 50 ms, oppure li nomina;
  - con reduced-motion restano solo le dissolvenze da 150 ms.
- **Confronto con chrome-devtools-mcp** su una stessa pagina: LCP, CLS e INP del `perf_trace` entro una tolleranza dichiarata rispetto a quelli di chrome-devtools-mcp 1.10.1 (reinstallabile per la prova con `npx -y chrome-devtools-mcp@1.10.1`).
