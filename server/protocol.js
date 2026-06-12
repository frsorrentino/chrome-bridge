/**
 * Costanti del protocollo e helper per la comunicazione WebSocket.
 */

import { randomBytes } from 'node:crypto';

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
  READ_CONSOLE:         'read_console',
  MONITOR_NETWORK:      'monitor_network',
  CREATE_TAB:           'create_tab',
  WAIT_FOR_ELEMENT:     'wait_for_element',
  SCROLL_TO:            'scroll_to',
  SET_STORAGE:          'set_storage',
  FILL_FORM:            'fill_form',
  VIEWPORT_RESIZE:      'viewport_resize',
  FULL_PAGE_SCREENSHOT: 'full_page_screenshot',
  ELEMENT_SCREENSHOT:   'element_screenshot',
  HIGHLIGHT_ELEMENTS:   'highlight_elements',
  ACCESSIBILITY_AUDIT:  'accessibility_audit',
  COLLECT_LINKS:        'collect_links',
  MEASURE_SPACING:      'measure_spacing',
  WATCH_DOM:            'watch_dom',
  EMULATE_MEDIA:        'emulate_media',
  HOVER:                'hover',
  PRESS_KEY:            'press_key',
  GET_FRAMES:           'get_frames',
  TAB_ACTION:           'tab_action',
  UPLOAD_FILE:           'upload_file',
  WAIT_FOR_NAVIGATION:   'wait_for_navigation',
  WAIT_FOR_NETWORK_IDLE: 'wait_for_network_idle',
  HANDLE_DIALOGS:        'handle_dialogs',
  FIND_TEXT:             'find_text',
  NETWORK_RULES:         'network_rules',
  SCREENSHOT_DIFF:       'screenshot_diff',

  // Risposte (extension → server)
  RESULT: 'result',
  ERROR:  'error',

  // Heartbeat
  PING: 'ping',
  PONG: 'pong',

  // Handshake identificazione connessione
  EXT_INIT:   'ext_init',
  RELAY_INIT: 'relay_init',
});

// Versione
export const VERSION               = '1.1.0';

// Configurazione
export const DEFAULT_PORT          = 8765;
export const COMMAND_TIMEOUT_MS    = 30000;  // 30s per comandi normali
export const SCREENSHOT_TIMEOUT_MS = 10000;  // 10s per screenshot
export const PING_INTERVAL_MS      = 15000;  // 15s heartbeat
export const IDENT_TIMEOUT_MS      = 5000;   // tempo max per identificarsi
export const PENDING_RELAY_TTL_MS  = 150000; // deve superare il timeout comando più lungo (120s full_page_screenshot)

// Entropia per instance + contatore globale per ID univoci
// 4 byte casuali per processo (2^32 valori): sufficiente per un bridge locale
const instanceId = randomBytes(4).toString('hex');
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
    id: `msg_${instanceId}_${messageCounter}`,
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
  if (type === MessageType.SCREENSHOT
    || type === MessageType.ELEMENT_SCREENSHOT
    || type === MessageType.SCREENSHOT_DIFF) return SCREENSHOT_TIMEOUT_MS;
  if (type === MessageType.FULL_PAGE_SCREENSHOT) return 120000;
  if (type === MessageType.WAIT_FOR_ELEMENT
    || type === MessageType.WAIT_FOR_NAVIGATION
    || type === MessageType.WAIT_FOR_NETWORK_IDLE
    || type === MessageType.UPLOAD_FILE) return 60000;
  return COMMAND_TIMEOUT_MS;
}
