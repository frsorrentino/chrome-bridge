/**
 * Istruzioni del server MCP: dette una volta all'initialize invece che
 * ripetute in ogni descrizione tool, pesano ~1 volta nel contesto del client
 * anziché ~50.
 *
 * Claude Code le taglia: 4.096 caratteri dalla 2.1.296, 2.048 fino alla
 * 2.1.295. RULES deve entrare nei primi 2.048; TAIL ripete quello che dicono
 * già le descrizioni dei tool, quindi un client vecchio la può perdere.
 * test/unit/instructions.test.js tiene i due limiti.
 */

export const RULES = [
  // Eval del 29/09: con Claude in Chrome richiesto e assente, il modello
  // ripiegava su chrome-bridge senza chiedere (2 casi su 2).
  'If the user names another browser tool (e.g. Claude in Chrome) and it is not available, say so and ask; do not switch to chrome-bridge on your own.',
  // Il costo dominante sono i TURNI, non i byte: un turno vale ~15-30 volte
  // un KB di output risparmiato. Queste due clausole si pagano una volta
  // qui e valgono più di qualunque ottimizzazione di schema.
  'Several fields: one fill_form (submit_selector submits in the same call), not repeated type_text: one turn instead of N.',
  'Tables: extract_table (where/columns filtered server-side) or extract, never read_page: a big table through read_page costs tens of thousands of tokens.',
  // Debug del 29/09: in 7 run su 20 il modello caricava la skill prima di
  // agire e pagava ~2 turni. La regola che serve sta qui, già in contesto.
  'Debugging a page: navigate already reports the first console error mapped to its source line and the failed requests with status; get_css_styles names the rule behind a style and flags undefined_vars. Start there; no skill or recipe needed.',
  'Detail in a screenshot: element_screenshot (selector or region, scale), not another full one. To check an outcome: assert or wait_for poll for you, no screenshot.',
  // Il 42% delle sessioni reali caricava i tool con 2+ ToolSearch (media 2,0).
  'When tools are deferred, batch every tool needed for the next workflow into ONE ToolSearch call using exact names (select:name1,name2,...); do not search one tool at a time.',
  'Missing optional tools: call get_status({enable:["group",...]}) once for all required groups (audits, visual, network, storage, dom, files, perf; "all" enables all). After tools/list_changed, use them next turn; if still deferred, batch-search their names once. No restart or user configuration needed.',
  // 14/10/2026: nei flussi di lavoro Claude restava fermo sulla finestra
  // «Salva con nome», di sistema e fuori portata dell'estensione. Su ChromeOS
  // con «Chiedi dove salvare ciascun file» si apre anche con saveAs:false.
  'Saving a file: never click a Download/Export button and wait for the browser download, the OS "Save as" dialog can open and no tool can press it. '
    + 'A file with a URL: http_request with save_to (browser cookies, bytes written to disk, no dialog). '
    + 'A file the page builds itself (blob, data URL, showSaveFilePicker, a download the page starts): capture_downloads arm, then click, then capture_downloads wait.',
  // Il blocco più frequente sul campo (Meta Ads Manager, 23/09/2026): tre
  // attese scadute e due screenshot falliti prima di capire che la
  // finestra era dietro un'altra.
  'A tab in a minimized, covered or background window does not render: screenshots fail, timers slow down. get_page_info reports visibility (page_hidden in a result means the same); bring the window on screen, or create_tab new_window with bounds.',
];

// Le ripetono le descrizioni di read_page, get_interactives, navigate e
// fill_form, e dei parametri ref, tab_id, frame_id e selector.
export const TAIL = [
  'To find targets use get_interactives, not read_page(html); its refs (n1, n2…) are the ref param of click/type_text/hover and of fill_form fields, and navigate already returns them.',
  'tab_id omitted = the tab last navigated/created in this session, else the active tab. frame_id omitted = main frame (list frames with get_frames).',
  'Selectors on DOM tools pierce shadow DOM with ">>>" ("my-app >>> button.save").',
];

export const INSTRUCTIONS = [...RULES, ...TAIL].join(' ');
