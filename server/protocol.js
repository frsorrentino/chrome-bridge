/**
 * Costanti del protocollo e helper per la comunicazione WebSocket.
 */

// Tipi di messaggi WebSocket
export const MessageType = Object.freeze({
  // Comandi (server → extension)
  NAVIGATE:        'navigate',
  SCREENSHOT:      'screenshot',
  EXECUTE_JS:      'execute_js',
  CLICK:           'click',
  TYPE_TEXT:        'type_text',
  READ_PAGE:       'read_page',
  GET_TABS:        'get_tabs',
  GET_PAGE_INFO:   'get_page_info',
  GET_STORAGE:     'get_storage',
  GET_PERFORMANCE: 'get_performance',
  QUERY_DOM:       'query_dom',
  MODIFY_DOM:      'modify_dom',
  INJECT_CSS:      'inject_css',
  READ_CONSOLE:    'read_console',
  MONITOR_NETWORK: 'monitor_network',
  CREATE_TAB:      'create_tab',

  // Risposte (extension → server)
  RESULT: 'result',
  ERROR:  'error',

  // Heartbeat
  PING: 'ping',
  PONG: 'pong',
});

// Configurazione
export const DEFAULT_PORT          = 8765;
export const COMMAND_TIMEOUT_MS    = 30000;  // 30s per comandi normali
export const SCREENSHOT_TIMEOUT_MS = 10000;  // 10s per screenshot
export const PING_INTERVAL_MS     = 15000;  // 15s heartbeat

// Contatore globale per ID univoci
let messageCounter = 0;

/**
 * Crea un oggetto comando da inviare all'estensione.
 *
 * @param {string} type - Tipo di comando (da MessageType)
 * @param {object} params - Parametri del comando
 * @returns {object} Comando serializzabile in JSON
 */
export function createCommand(type, params = {}) {
  messageCounter += 1;
  return {
    id: `msg_${messageCounter}_${Date.now()}`,
    type,
    params,
    timestamp: Date.now(),
  };
}

/**
 * Restituisce il timeout appropriato per un tipo di comando.
 *
 * @param {string} type - Tipo di comando
 * @returns {number} Timeout in millisecondi
 */
export function getTimeout(type) {
  return type === MessageType.SCREENSHOT
    ? SCREENSHOT_TIMEOUT_MS
    : COMMAND_TIMEOUT_MS;
}
