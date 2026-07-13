# Popup redesign 1.7.0 — spec

Data: 2026-07-13 · Stato: approvata (brainstorming con mockup visivi)

## Obiettivo

Il popup attuale (240px, stato + config) è scarno e il warning "Allow user scripts"
è poco visibile. Diventa uno strumento di troubleshooting e osservabilità rapida
per l'utente umano, complementare (mai doppione) ai tool MCP che usa Claude.

## Design visivo approvato

Design unico adattivo, larghezza 320px, vanilla HTML/CSS/JS (nessun framework).
Tema automatico via CSS variables + `prefers-color-scheme`:

- **Light**: bianco, accenti blu Google (#1a73e8), superfici #f8f9fa
- **Dark**: palette GitHub-dark (#0d1117 fondo, #161b22 superfici, accento verde
  #3fb950 per lo stato connesso, testo #e6edf3)

Mockup di riferimento: `.superpowers/brainstorm/27088-1783949274/content/theme-auto.html`

## Struttura popup (dall'alto)

1. **Header** — logo, "Chrome Bridge", versione extension + versione server
2. **Stato connessione** — pallino colorato (verde/ambra/rosso), label, endpoint
   `ws://localhost:<porta>` in monospace
3. **Warning userScripts** (solo se toggle spento) — box ambra prominente con
   titolo, spiegazione breve e bottone **"Apri impostazioni →"** che apre
   `chrome://extensions/?id=<runtime.id>` via `chrome.tabs.create`
4. **Pagina corrente** (card) — dati della tab attiva:
   - Errori console (conteggio, rosso se >0)
   - LCP / CLS (da instrumentation)
   - Stack rilevato (es. "React · Vite · Tailwind")
5. **Contatori sessione** (3 stat tile) — tool call totali, ultimo tool +
   quanto tempo fa, errori sessione
6. **Azioni** — ↻ Riconnetti · ⧉ Diagnostica (copia report) · ⚙ (espande config)
7. **Config collassata** (dietro ⚙) — porta, token, checkbox instrument,
   Save & Reconnect (contenuto identico all'attuale)

## Architettura dati

### Service worker (estensioni a ws-client esistente)

- Contatori sessione: `toolCallCount`, `lastTool`, `lastToolTs`, ring buffer
  ultimi 5 errori `{ts, tool, message}`. Incrementati nel dispatch dei comandi.
- Persistenza in `chrome.storage.session`: sopravvive alla morte del SW MV3,
  si azzera al riavvio del browser (semantica corretta per "sessione").
- Versione server: dal handshake WS (se assente nel protocollo attuale,
  aggiungerla al messaggio di hello/welcome).
- Nuovi messaggi runtime per il popup: `getPopupData` (stato + contatori +
  versioni), `reconnect`, `getPageInfo`.

### Pagina corrente

Su apertura popup: popup → SW `getPageInfo` → SW esegue
`chrome.scripting.executeScript` sulla tab attiva:

- **Errori console e vitals**: letti dai buffer già raccolti da
  `console-capture.js` / `page-instrumentation.js` (richiede toggle
  instrument ON).
- **Stack detect**: nuovo file statico `stack-detect.js` (~50 righe), eseguito
  world MAIN, euristiche: `window.React`/`__REACT_DEVTOOLS_GLOBAL_HOOK__`, Vue,
  Angular, Svelte, jQuery, meta generator (WordPress/PrestaShop/...), classi
  Tailwind, script Vite/webpack. Restituisce array di nomi.
- Codice statico del pacchetto → nessuna dipendenza dal permesso userScripts,
  CWS-compliant (nessuna elusione: il gate resta per il codice utente).

### Azioni

- **Riconnetti**: SW chiude e riapre il WS con config corrente.
- **Diagnostica**: copia negli appunti JSON con versioni (extension, server,
  Chrome), stato connessione, porta, toggle userScripts/instrument, ultimi
  errori. Per supporto/issue GitHub.
- **Fix userScripts**: `chrome.tabs.create({url:
  'chrome://extensions/?id=' + chrome.runtime.id})`.

## Degradazione

- Tab non iniettabile (chrome://, Web Store, pagina extension): card Pagina
  corrente mostra "Non disponibile su questa pagina".
- Instrument OFF: al posto di errori/vitals una riga hint "Attiva capture
  (⚙) per errori console e metriche" — stack detect funziona comunque.
- Server senza versione nel handshake (vecchio server): mostra solo versione
  extension.
- WS disconnesso: contatori restano visibili (ultimo valore noto), stato rosso.

## Fuori scope

- Analisi SEO/a11y/security nel popup (esistono i tool MCP `audit`).
- Log completi o storico oltre gli ultimi 5 errori.
- Framework UI, build step, librerie di detection esterne (Wappalyzer-like).

## Testing

- Unit (node --test, pattern esistente): euristiche di stack-detect su DOM/global
  simulati; formatter del report diagnostica; ring buffer errori.
- Manuale: popup su tab normale con/senza instrument, su chrome://, con toggle
  userScripts on/off, dark/light, riconnessione.

## Versioning

- Bump 1.7.0 (manifest + package.json), voce CHANGELOG, nuovo zip con
  `scripts/package-extension.sh`, upload CWS (procedura in memoria:
  webstore-cdp-workaround).
