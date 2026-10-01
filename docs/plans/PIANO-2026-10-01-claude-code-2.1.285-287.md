# Migliorie da Claude Code 2.1.285-2.1.287 (01/10/2026)

La sezione chrome-bridge di `workspaces/.claude/piani/2026-10-01-claude-code-2.1.285-287-migliorie.md`, chiesta da Franz alle 21:34 via master. Regole: solo commit locali, niente release; la 1.27.0 resta com'è.

| # | Voce | Stato | Prova | Commit |
|---|---|---|---|---|
| 1 | `alwaysLoad` per tool | fatto | Serie w128b su Windows (02/10, bracci alternati, fuori dal repository): turni uguali o migliori, risposte corrette uguali o migliori in ogni task. Le 3 mancate dipendono dall'ambiente (server MCP non partito, estensione non collegata, connessione chiusa) e sono divise fra i bracci. Sempre caricati 22 tool, circa 6,4k token contro circa 12,2k. La w128a era falsata dallo stato git del repository. Dettagli in `bench/RESULTS.md`. | 27e66e5, 9928357, commit w128b |
| 2 | `claude mcp get` nasconde comando e argomenti dei server dei plugin | fatto | `claude mcp get chrome-bridge` su 2.1.287. Qui il server è registrato a livello utente e mostra ancora comando e argomenti. Nessun file del repository legge quell'output; nel README una riga di Troubleshooting rimanda a `get_status` e `/mcp`. | 27e66e5 |
| 3 | Elicitation MCP | fatto (form); URL scartata | `tools-handoff-terminal.test.js` 4/4 con un client MCP vero. La prova in una sessione interattiva resta da fare. | 27e66e5 |
| 4 | Più browser: niente furti di connessione | fatto; prova dal vivo incompleta | `ws-manager-browsers.test.js` 4/4 con WebSocket veri: secondo browser rifiutato (4409), il primo resta, poi subentra. Dal vivo, con due Chromium in launch e carico fra 25 e 31: il primo resta collegato e riceve i comandi, e il secondo entra dopo la chiusura del primo. Il rifiuto in sé, dal vivo, non si è visto: il secondo browser non ha tentato in tempo, e nella seconda prova il primo si è scollegato. | 27e66e5 |
| 5 | Mods | valutazione, rinviato | Sezione qui sotto | piano |
| 6 | `upload_file` oltre 10 MB | fatto | `upload.test.js` 4/4; e2e in launch: 25 MB in 5 pezzi, SHA-256 identico nella pagina, 30,5 s con carico a 27 | 27e66e5 |

Suite e2e del 01/10 alle 22:35 (carico 27-31): 86/89. I tre falliti:
- `viewport_resize`: noto;
- CPU ×4: misurata 1,3 volte sotto carico (alle 18:30 era 3,8-4,7);
- `lighthouse`: oltre 240 s. Alle 18:30 era passato in 50 s.

Unit 489/490: il fallito è `link-checker`, instabile sotto carico (da solo 2 volte su 2).

**Benchmark della voce 1, da lanciare a macchina scarica:**

1. `node build.mjs` in `bench/debug`.
2. `python3 -m http.server 8099 --bind 127.0.0.1 -d bench`.
3. `CHROME_BRIDGE_CAPS=core TASKS="form heavy debug" bash bench/run-series-v2.sh bridge v128a 5`.
4. `CHROME_BRIDGE_CAPS=core TASKS="form heavy debug" bash bench/run-series-v2.sh bridgeall v128a 5`.
5. `python3 bench/aggregate.py bridge:v128a bridgeall:v128a`.

Sono circa 30 run da 0,2 $. Criterio: turni e risposte corrette di `bridge` non peggiori di `bridgeall`. Se peggiorano, la lista `EAGER_TOOLS` si allarga.

## Voce 3: elicitation

`handoff` chiede anche nel terminale con una richiesta form (`elicitation/create`), in parallelo al banner nella pagina; vince la prima risposta.

- **Accetta nel terminale:** il server manda `handoff_end`, il banner sparisce e la chiamata ritorna con `via=terminal`. Con `ask` ritorna anche la risposta.
- **Clic sul banner prima:** il server annulla la richiesta nel terminale con `notifications/cancelled`.
- **Esclusi:** `pick_element` resta solo nella pagina; `in_terminal: false` torna al solo banner.

**Modalità URL scartata:** apre il link nel browser predefinito, che può non essere il Chrome in cui lavora l'agente. Per un login nella scheda dell'agente serve una conferma, non un link.

**Ancora da provare dal vivo:** la resa in una sessione interattiva di Claude Code. In modalità `-p` le elicitation si annullano da sole.

## Voce 5: Mods, valutazione (niente codice)

Fonte: il riferimento dei Mods per la v2.1.287. Un mod è un plugin con `hooks/hooks.json` → `modules`, che esporta `register(on, options)`. L'interfaccia è dichiarata nuova e può cambiare a ogni versione.

| Idea | Cosa darebbe | Valore oggi | Rischio |
|---|---|---|---|
| `tool.describe` | Riscrivere al volo le descrizioni dei tool di chrome-bridge, per sessione | Basso: le descrizioni le controlla già il server, e i tool rimandati (voce 1) riducono lo schema più di qualunque riscrittura | Due fonti di verità per lo stesso testo |
| `$.mcp.connect(server)` | Collegare il server solo quando serve | Basso con il plugin: il server parte in circa 100 ms e non apre browser. Utile solo in modalità launch, dove avvia Chromium | Il primo tool della sessione aspetta l'avvio |
| Pannello `Image` (solo terminale, PNG fino a 2 MiB) | Una «vista dal vivo» della scheda dell'agente: il mod chiama `$.mcp.call('chrome-bridge', 'screenshot')` ogni N secondi, senza passare dal modello e quindi a zero token | Medio: si vede cosa fa l'agente senza guardare il browser | Gli screenshot passano dalla quota di Chrome (2 al secondo) e possono rubare il turno a uno screenshot dell'agente. Su Desktop il pannello non c'è. |

**Esito: rinviato.** Se Franz vuole, il primo prototipo è la vista dal vivo:

- sul ramo `mods-prototipo`, dopo la skill `plugin-authoring`;
- uno screenshot ogni 5 s, solo mentre un turno è in corso (`turn.start`/`turn.complete`);
- pausa quando la pagina è nascosta;
- verifica: `claude plugin test` e una sessione con `--plugin-dir`.
