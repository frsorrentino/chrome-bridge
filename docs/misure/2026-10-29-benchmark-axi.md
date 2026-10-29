# Benchmark axi: chrome-bridge contro chrome-devtools-axi, 2026-10-29

Esito: sulla stessa macchina chrome-bridge 1.32.1 risolve tutti i 14 compiti
(42/42) e costa il 17% in meno a compito rispetto a chrome-devtools-axi
($0,131 contro $0,158). Legge però il 13% di token in più e fa 1,4 turni in più.
La 1.32.0 perdeva due run su github_issue_investigation per il markdown vuoto
di read_page, corretto nella 1.32.1.

## Numeri

Medie a compito. Tutte e tre le serie sono girate su win (Windows, Chrome
headless) con agente e giudice claude-sonnet-4-6.

| Serie | Run | Riuscite | Token input | Token output | Costo | Durata | Turni | Costo totale |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| chrome-devtools-axi | 70 | 70 | 161 725 | 932 | $0,158 | 27,0 s | 4,9 | $11,04 |
| chrome-bridge 1.32.0 | 70 | 68 | 210 477 | 1 048 | $0,151 | 26,2 s | 7,2 | $10,60 |
| chrome-bridge 1.32.1 | 42 | 42 | 182 749 | 844 | $0,131 | 20,9 s | 6,3 | $5,50 |

Risultati pubblicati da axi per chrome-devtools-axi, su un'altra macchina:
79 141 token, $0,074, 21,5 s, 4,5 turni, 100%. Sulla nostra macchina axi legge
il doppio dei token. Per questo il confronto vale solo fra serie girate qui.

I costi sono in dollari equivalenti API. Le run le ha pagate l'abbonamento.

Per compito: token input in migliaia, costo, turni, riuscite.

| Compito | axi | chrome-bridge 1.32.0 | chrome-bridge 1.32.1 |
|---|---|---|---|
| github_issue_investigation | 92k · $0,113 · 3,0 · 5/5 | 409k · $0,297 · 13,0 · 3/5 | 157k · $0,134 · 5,7 · 3/3 |
| github_navigate_to_file | 152k · $0,136 · 4,6 · 5/5 | 167k · $0,120 · 5,4 · 5/5 | 165k · $0,120 · 5,3 · 3/3 |
| github_repo_stars | 124k · $0,116 · 4,0 · 5/5 | 320k · $0,186 · 11,0 · 5/5 | 316k · $0,180 · 10,7 · 3/3 |
| multi_page_comparison | 163k · $0,141 · 5,0 · 5/5 | 202k · $0,128 · 6,6 · 5/5 | 226k · $0,182 · 7,3 · 3/3 |
| multi_site_research | 330k · $0,317 · 9,2 · 5/5 | 340k · $0,335 · 15,4 · 5/5 | 264k · $0,206 · 13,0 · 3/3 |
| navigate_404 | 124k · $0,098 · 4,2 · 5/5 | 179k · $0,114 · 6,0 · 5/5 | 158k · $0,105 · 5,3 · 3/3 |
| read_static_page | 160k · $0,106 · 5,4 · 5/5 | 130k · $0,082 · 4,4 · 5/5 | 118k · $0,086 · 4,0 · 3/3 |
| tabular_data_analysis | 127k · $0,124 · 4,0 · 5/5 | 119k · $0,091 · 4,0 · 5/5 | 119k · $0,091 · 4,0 · 3/3 |
| wikipedia_deep_extraction | 266k · $0,239 · 7,6 · 5/5 | 158k · $0,147 · 5,2 · 5/5 | 152k · $0,124 · 5,0 · 3/3 |
| wikipedia_fact_lookup | 92k · $0,109 · 3,0 · 5/5 | 122k · $0,103 · 4,0 · 5/5 | 122k · $0,103 · 4,0 · 3/3 |
| wikipedia_infobox_hop | 134k · $0,159 · 4,0 · 5/5 | 220k · $0,140 · 7,0 · 5/5 | 196k · $0,128 · 6,3 · 3/3 |
| wikipedia_link_follow | 136k · $0,164 · 4,0 · 5/5 | 191k · $0,123 · 6,2 · 5/5 | 185k · $0,121 · 6,0 · 3/3 |
| wikipedia_search_click | 182k · $0,237 · 5,0 · 5/5 | 234k · $0,149 · 7,4 · 5/5 | 223k · $0,148 · 7,0 · 3/3 |
| wikipedia_table_read | 176k · $0,147 · 5,6 · 5/5 | 150k · $0,105 · 5,0 · 5/5 | 150k · $0,105 · 5,0 · 3/3 |

## Cosa dicono

- chrome-bridge legge più token ma costa meno. Il suo prefisso resta in cache
  meglio: per esempio 95% di cache contro 83% su wikipedia_search_click.
- I turni in più vengono dal caricamento differito dei tool. Nella serie 1.32.0
  le trascrizioni contano 111 chiamate ToolSearch, 1,6 a run. Nella 1.32.1
  non sono state contate.
- github_repo_stars resta il compito peggiore: 316k token e 10,7 turni contro
  124k e 4,0 di axi. È il prossimo da studiare.
- La 1.32.0 aveva 23 letture markdown vuote: read_page `format: markdown`
  restituiva 0 caratteri su ogni pagina reale dalla 1.11.0. Con la 1.32.1
  github_issue_investigation passa da 409k token, 13 turni e 3/5 a 157k,
  5,7 turni e 3/3.

## Metodo

- Bench: kunchenguid/axi, cartella bench-browser, 14 compiti. axi e la 1.32.0
  con 5 ripetizioni; la 1.32.1 con 3, per restare sotto i 10 dollari
  equivalenti (con 5 la spesa stimata superava il tetto).
- Agente e giudice: `claude -p` con claude-sonnet-4-6, lo stesso modello
  dell'originale. Claude Code 2.1.310.
- Condizione aggiunta in `config/conditions.yaml`: chrome-bridge come MCP con
  tool differiti, avviato con `node <pacchetto npm>/server/index.js --launch --headless`.
  Il ramo del runner è lo stesso di chrome-devtools-mcp-search.
- Versioni: pacchetti npm chrome-bridge-mcp 1.32.0 e 1.32.1, installati in due
  cartelle separate.

## Differenze dall'originale

- Macchina Windows al posto di quella dei risultati pubblicati. Per questo axi
  è stato rifatto qui.
- `CLAUDE_BIN` punta a claude.exe, perché da execFileSync Windows non trova lo
  shim `claude.cmd`.
- Un MCP stdio non parte con `npx` senza `cmd /c`, quindi si usa `node` col
  percorso del pacchetto.
- Il giudice riceve il prompt da stdin e non come argomento. Su Windows una
  riga di comando oltre 32 767 caratteri fa fallire il processo: era
  successo a 10 giudizi su axi e a 3 su chrome-bridge 1.32.0. Quei giudizi
  sono stati ripetuti con `regrade.ts` sugli stessi `agent_output.txt`.
  Nessun giudizio fallito nella serie finale.
- La pulizia della cartella di lavoro tollera EPERM e riprova. Prima la serie
  axi si era fermata a 47 run su 70.
- Da ottobre 2026 example.com non ha più `<h1>`. read_static_page vale per
  tutte le condizioni, ma il compito ora misura come l'agente lo scopre.
- Le due run di multi_site_research della prima serie axi interrotta sono state
  scartate e rifatte, per avere cinque run della stessa serie.

Dati grezzi su win, in `D:\workspaces\personali\axi-bench\bench-browser\`:
`results/` (axi e 1.32.1) e `results-cb1320/` (1.32.0).
