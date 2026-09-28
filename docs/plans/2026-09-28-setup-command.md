# Piano — comando `/chrome-bridge:setup` (e modello per gli altri plugin)

Stato: proposta, 2026-09-28. Nessun codice scritto.

## Problema

Dopo `/plugin install` il server MCP parte da npm, ma l'estensione no: va presa
dallo Store a mano, e oggi l'utente scopre che manca solo alla prima chiamata
fallita. Serve un passo unico che porti da «plugin installato» a «pronto, provato».

## Cosa fa il comando

`commands/setup.md`, idempotente: rilanciarlo a setup completo costa una
chiamata e risponde «pronto».

1. **Stato.** `chrome-bridge status` (CLI a zero token, stessa versione del
   server: `npx -y -p chrome-bridge-mcp@<versione> chrome-bridge status`, già in
   cache perché il server MCP l'ha scaricato). Tre esiti:
   - `server=ok extension=connected` → salta al punto 4;
   - `server=ok extension=disconnected` → punto 2;
   - server non raggiungibile → dice di riavviare la sessione o controllare
     `/mcp`, e si ferma. Non prova ad avviarlo lui: lo avvia Claude Code.
2. **Store.** Apre la pagina dello Store nel browser predefinito:
   `xdg-open` (Linux, e su Crostini passa al Chrome host via garcon),
   `open` (macOS), `cmd /c start` (Windows/Git Bash). Stampa comunque l'URL,
   se l'apertura fallisce. Dice in una riga cosa fare: «Aggiungi a Chrome».
3. **Attesa.** Uno script (`scripts/setup-wait.mjs`, senza dipendenze oltre
   `ws`) interroga lo stato ogni 2 s, per massimo 3 minuti, e stampa una sola
   riga all'esito. L'attesa costa zero token: il modello non fa polling.
   Scaduto il tempo: dice cosa controllare (estensione attiva? porta 8765
   occupata da un altro server? profilo Chrome diverso?) e si ferma.
4. **Prova.** Una chiamata di sola lettura via MCP: `get_status` (versioni di
   server ed estensione) e `get_tabs` (conta le schede). Controlli:
   - versione estensione ≠ server → avviso «aggiorna da chrome://extensions»,
     non bloccante;
   - `execute_js` di `1+1`: se fallisce per il toggle, dice dove si accende
     «Allow user scripts». Non bloccante: gli altri tool funzionano.
5. **Esito.** Una riga: `Pronto: estensione 1.23.4 connessa, 16 schede, execute_js attivo.`
   Oppure l'elenco di cosa manca, un punto per riga.

Non fa mai: login, inserimento di credenziali, installazione dell'estensione al
posto dell'utente (Chrome non lo permette, ed è giusto così).

## Aggancio all'installazione

Il SessionStart del plugin (già presente per observe) aggiunge un solo
suggerimento, una volta, se l'estensione non si è mai connessa:
«Estensione non ancora collegata: /chrome-bridge:setup». Dopo la prima
connessione riuscita tace per sempre (marker in `~/.config/chrome-bridge/`).

## Modello per gli altri plugin

Lo stesso scheletro vale per ogni plugin che dipende da un pezzo esterno
(estensione, app, credenziale, servizio locale):

| Fase | Contratto |
|------|-----------|
| rileva | un comando deterministico con esiti enumerati, zero token |
| procura | apre la pagina giusta o stampa il comando; mai eseguire al posto dell'utente ciò che richiede fiducia o credenziali |
| attendi | script con polling e timeout, una riga all'esito |
| prova | una chiamata reale, di sola lettura |
| esito | una riga «pronto» o l'elenco di cosa manca |

Regole comuni: idempotente; ogni fase si salta se già soddisfatta; nessuna
domanda all'utente salvo scelte vere; il suggerimento a SessionStart si spegne
dopo il primo successo. Candidati da allineare dopo: claude-observe (nessun
pezzo esterno: solo «prova»), claude-master, fable-director (statusline).

## Verifica

- profilo Chrome senza estensione: apre lo Store, dopo l'installazione
  rileva la connessione in ≤ 4 s, «pronto»;
- estensione già connessa: «pronto» senza aprire nulla;
- estensione disattivata: timeout con la lista dei controlli;
- toggle user scripts spento: «pronto» con avviso su execute_js;
- Windows (Git Bash), macOS, ChromeOS: l'apertura della pagina funziona.

## Domande aperte

- `setup-wait.mjs` nel plugin gira con il `node` dell'utente: nel plugin da
  marketplace `node_modules` non c'è. O lo lanciamo via `npx -p
  chrome-bridge-mcp` (bin nuovo `chrome-bridge-setup`), o lo scriviamo senza
  `ws` interrogando un endpoint HTTP di stato del server, che oggi non esiste.
- Il suggerimento a SessionStart costa token in ogni sessione finché non si
  spegne: accettabile solo se resta una riga.
