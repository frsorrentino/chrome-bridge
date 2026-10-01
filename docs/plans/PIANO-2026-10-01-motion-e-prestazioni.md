# Piano: misure di movimento e prestazioni (01/10/2026)

Origine: `BRIEF-2026-10-01-motion-e-prestazioni.md`. Decisioni di Franz, 01/10 alle 17:34:

- tutti e sette i tool, `heap_snapshot` compreso;
- `emulate_media` esteso, non un tool `emulate` nuovo;
- il motore dei trace come dipendenza opzionale;
- l'ordine lo sceglie la sessione;
- nessuna release senza il suo ok.

## Tappa 0: la prova dei domini (fatta, 01/10)

La prova gira su Chromium 154 (`/usr/bin/chromium`), con l'estensione caricata, in headless e con finestra. I comandi CDP partono da `chrome.debugger.sendCommand` in una pagina dell'estensione.

| Dominio | Esito |
|---|---|
| `Emulation.setEmulatedMedia` (reduced-motion) | ok, e `matchMedia` lo vede |
| `Emulation.setCPUThrottlingRate`, `setDeviceMetricsOverride`, `setTouchEmulationEnabled` | ok |
| `Network.emulateNetworkConditions` | ok |
| `Tracing.start/end` (`ReportEvents`) | ok, 5 000-5 700 eventi su un ricaricamento |
| `Page.startScreencast` | ok, ma i fotogrammi arrivano solo con la scheda attiva: 0 con la scheda in secondo piano, 25-55 in 1,5 s se attiva |
| `HeapProfiler.*` | **rifiutato**: «wasn't found». `heap_snapshot` sarà solo in modalità launch, tramite la porta CDP |
| `Animation.*`, `PerformanceTimeline.*` | rifiutati: `animations` e `frames` restano script nella pagina, come previsto |

Il Chrome di Franz non è stato provato con lo script. La lista dei domini ammessi è codice di Chromium, uguale nel Chrome con marchio; la conferma arriva con il primo uso reale nella tappa 2.

Nota per i test: con l'estensione caricata senza permessi host concessi, `chrome.scripting` non entra nella pagina. La prova usa `Runtime.evaluate` attraverso il debugger.

Incidente del 01/10, 17:42-17:48: lo script di prova caricava l'estensione del repo con la porta di default 8765. I Chromium rimasti vivi hanno preso la connessione al Chrome di Franz, e i comandi delle altre sessioni rimbalzavano fra i browser. Le prove successive passano da `prepareLaunch(port)` su una porta propria. Difetto possibile, da valutare a parte: sulla stessa porta vince l'ultimo browser collegato, senza avviso.

## Checklist

- [x] Tappa 0: la prova dei domini
- [ ] Tappa 1: gruppo `perf`, `animations` (istantanea e finestra con azione), `frames` (LoAF, CLS, INP, rAF); test unitari di `lib/motion.js`; pagina di prova in `bench/`; e2e in launch
- [x] Tappa 2 (e2e 78/79; esempio in `assert` scartato: assert controlla DOM, testo e URL, la verifica sta in `animations` con `summary.not_fade_only` = 0, va nelle ricette): `emulate_media` con il debugger su richiesta (`Emulation.setEmulatedMedia`, CPU, rete, viewport/DPR, touch) e il ripiego dichiarato; esempio di reduced-motion in `assert`
- [x] Tappa 3 (e2e 82/83; il motore dei trace è un peer opzionale, npm non lo installa: API dichiarata instabile e due dipendenze a `latest`; analisi di base in `server/trace-analysis.js`): `perf_trace` (trace su file, analisi con `@paulirish/trace_engine` opzionale o ripiego interno) e `screencast` (ffmpeg, scheda attiva)
- [ ] Tappa 4: porta CDP del launch (`--remote-debugging-port=0`, `DevToolsActivePort`), `lighthouse` con `npx`, `heap_snapshot` solo in launch
- [ ] Per ogni tappa: `TOOLS.md`, `CAPABILITIES.md`, conteggi (`tool-counts.test.js`, README, package/server/manifest), CHANGELOG
- [ ] Verifica finale: lotto D3 di francescosorrentino.com e confronto con chrome-devtools-mcp 1.10.1
