#!/usr/bin/env node
/**
 * Test end-to-end per i nuovi DevTools tool di Chrome Bridge.
 *
 * Prerequisiti:
 * - Estensione Chrome caricata e connessa
 * - Server MCP NON in esecuzione (questo script avvia il proprio WSManager)
 *
 * Uso: node test/test-devtools.js
 */

import { WSManager } from '../server/ws-manager.js';
import { MessageType } from '../server/protocol.js';

const PORT = 8765;
const TIMEOUT_CONNECT = 30000;

let wsManager;
let passed = 0;
let failed = 0;
const results = [];

function log(msg) {
  console.log(`  ${msg}`);
}

function ok(name) {
  passed++;
  results.push({ name, status: 'PASS' });
  console.log(`  ✓ ${name}`);
}

function fail(name, err) {
  failed++;
  results.push({ name, status: 'FAIL', error: err });
  console.log(`  ✗ ${name}: ${err}`);
}

async function waitForConnection() {
  console.log(`\nWaiting for Chrome extension to connect (max ${TIMEOUT_CONNECT / 1000}s)...`);
  const start = Date.now();
  while (!wsManager.isConnected()) {
    if (Date.now() - start > TIMEOUT_CONNECT) {
      throw new Error('Timeout waiting for extension connection');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('Extension connected!\n');
}

// --- Test functions ---

async function testGetPageInfo(tabId) {
  const name = 'get_page_info';
  try {
    const data = await wsManager.sendCommand(MessageType.GET_PAGE_INFO, { tab_id: tabId });
    if (!data.title && data.title !== '') throw new Error('Missing title');
    if (!data.url) throw new Error('Missing url');
    if (!Array.isArray(data.metas)) throw new Error('metas not array');
    if (!Array.isArray(data.scripts)) throw new Error('scripts not array');
    if (!Array.isArray(data.stylesheets)) throw new Error('stylesheets not array');
    if (!Array.isArray(data.links)) throw new Error('links not array');
    if (!Array.isArray(data.forms)) throw new Error('forms not array');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testGetStorage(tabId) {
  const name = 'get_storage';
  try {
    const data = await wsManager.sendCommand(MessageType.GET_STORAGE, { type: 'all', tab_id: tabId });
    if (!('localStorage' in data)) throw new Error('Missing localStorage');
    if (!('sessionStorage' in data)) throw new Error('Missing sessionStorage');
    if (!('cookies' in data)) throw new Error('Missing cookies');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testGetPerformance(tabId) {
  const name = 'get_performance';
  try {
    const data = await wsManager.sendCommand(MessageType.GET_PERFORMANCE, { tab_id: tabId });
    if (!data.timing && data.timing !== null) throw new Error('Missing timing');
    if (!data.paint) throw new Error('Missing paint');
    if (!Array.isArray(data.resources)) throw new Error('resources not array');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testQueryDom(tabId) {
  const name = 'query_dom';
  try {
    const data = await wsManager.sendCommand(MessageType.QUERY_DOM, {
      selector: 'body',
      properties: ['display', 'margin'],
      limit: 5,
      tab_id: tabId,
    });
    if (typeof data.count !== 'number') throw new Error('Missing count');
    if (!Array.isArray(data.elements)) throw new Error('elements not array');
    if (data.count < 1) throw new Error('No body element found');
    const el = data.elements[0];
    if (!el.tagName) throw new Error('Missing tagName');
    if (!el.rect) throw new Error('Missing rect');
    if (!el.computedStyles) throw new Error('Missing computedStyles');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testModifyDom(tabId) {
  const name = 'modify_dom';
  try {
    const data = await wsManager.sendCommand(MessageType.MODIFY_DOM, {
      selector: 'body',
      action: 'setAttribute',
      name: 'data-chrome-bridge-test',
      value: 'true',
      tab_id: tabId,
    });
    if (!data.success) throw new Error('modify_dom returned success=false');
    // Cleanup
    await wsManager.sendCommand(MessageType.MODIFY_DOM, {
      selector: 'body',
      action: 'removeAttribute',
      name: 'data-chrome-bridge-test',
      tab_id: tabId,
    });
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testInjectCss(tabId) {
  const name = 'inject_css';
  try {
    const data = await wsManager.sendCommand(MessageType.INJECT_CSS, {
      css: '.__chrome_bridge_test { display: none !important; }',
      tab_id: tabId,
    });
    if (!data.success) throw new Error('inject_css returned success=false');
    if (typeof data.injectedLength !== 'number') throw new Error('Missing injectedLength');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testReadConsole(tabId) {
  const name = 'read_console';
  try {
    // Prima chiamata: inietta hook + legge (potrebbe essere vuoto)
    await wsManager.sendCommand(MessageType.READ_CONSOLE, { clear: true, tab_id: tabId });

    // Genera un log dalla pagina usando script tag injection
    // (execute_js usa ISOLATED world dove console non è patchato,
    //  ma un <script> tag esegue in MAIN world dove il hook cattura i log)
    await wsManager.sendCommand(MessageType.EXECUTE_JS, {
      code: "(() => { const s = document.createElement('script'); s.textContent = \"console.log('__chromeBridge_test_message__')\"; document.head.appendChild(s); s.remove(); })()",
      tab_id: tabId,
    });

    // Piccolo delay per assicurarsi che il monkey-patch catturi il log
    await new Promise((r) => setTimeout(r, 300));

    // Leggi i log
    const data = await wsManager.sendCommand(MessageType.READ_CONSOLE, { clear: true, level: 'all', tab_id: tabId });
    if (typeof data.count !== 'number') throw new Error('Missing count');
    if (!Array.isArray(data.messages)) throw new Error('messages not array');
    // Cerca il nostro messaggio di test
    const found = data.messages.some((m) =>
      m.args && m.args.some((a) => a.includes('__chromeBridge_test_message__'))
    );
    if (!found) throw new Error('Test console.log message not captured');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testMonitorNetwork(tabId) {
  const name = 'monitor_network';
  try {
    // Prima chiamata: inietta hook + legge (potrebbe essere vuoto)
    await wsManager.sendCommand(MessageType.MONITOR_NETWORK, { clear: true, tab_id: tabId });

    // Genera una fetch dalla pagina usando script tag injection (MAIN world)
    await wsManager.sendCommand(MessageType.EXECUTE_JS, {
      code: "(() => { const s = document.createElement('script'); s.textContent = \"fetch('/favicon.ico').catch(() => {})\"; document.head.appendChild(s); s.remove(); })()",
      tab_id: tabId,
    });

    // Delay per catturare la richiesta
    await new Promise((r) => setTimeout(r, 1000));

    const data = await wsManager.sendCommand(MessageType.MONITOR_NETWORK, { clear: true, tab_id: tabId });
    if (typeof data.count !== 'number') throw new Error('Missing count');
    if (!Array.isArray(data.requests)) throw new Error('requests not array');
    // Nota: la richiesta potrebbe fallire (404) ma deve essere catturata
    if (data.count < 1) throw new Error('No network requests captured');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

// --- Main ---

async function main() {
  console.log('=== Chrome Bridge DevTools Test ===\n');

  wsManager = new WSManager(PORT);
  await wsManager.start();

  try {
    await waitForConnection();

    // Crea un nuovo tab dedicato per i test (evita di sovrascrivere il terminale su ChromeOS)
    console.log('Creating test tab...');
    const tabData = await wsManager.sendCommand(MessageType.CREATE_TAB, { url: 'https://example.com', active: true });
    const testTabId = tabData.id;
    console.log(`Test tab created: id=${testTabId}, url=${tabData.url}\n`);
    await new Promise((r) => setTimeout(r, 500));

    // Override: tutti i test usano il tab_id esplicito
    const withTab = (params = {}) => ({ ...params, tab_id: testTabId });

    console.log('Running tests:\n');

    await testGetPageInfo(testTabId);
    await testGetStorage(testTabId);
    await testGetPerformance(testTabId);
    await testQueryDom(testTabId);
    await testModifyDom(testTabId);
    await testInjectCss(testTabId);
    await testReadConsole(testTabId);
    await testMonitorNetwork(testTabId);

    console.log(`\n=== Results: ${passed}/${passed + failed} passed ===`);
    if (failed > 0) {
      console.log('\nFailed tests:');
      for (const r of results.filter((x) => x.status === 'FAIL')) {
        console.log(`  - ${r.name}: ${r.error}`);
      }
    }
  } finally {
    await wsManager.stop();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
