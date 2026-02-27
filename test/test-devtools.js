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

// --- New tool tests ---

async function testWaitForElement(tabId) {
  const name = 'wait_for_element (found)';
  try {
    const data = await wsManager.sendCommand(MessageType.WAIT_FOR_ELEMENT, { selector: 'body', timeout: 5000, tab_id: tabId });
    if (!data.found) throw new Error('body not found');
    if (!data.tagName) throw new Error('Missing tagName');
    if (typeof data.elapsed !== 'number') throw new Error('Missing elapsed');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testWaitForElementTimeout(tabId) {
  const name = 'wait_for_element (timeout)';
  try {
    const data = await wsManager.sendCommand(MessageType.WAIT_FOR_ELEMENT, { selector: '#__nonexistent_element_xyz__', timeout: 500, interval: 100, tab_id: tabId });
    if (data.found !== false) throw new Error('Should not have found element');
    if (!data.error) throw new Error('Missing error message');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testScrollTo(tabId) {
  const name = 'scroll_to';
  try {
    const data = await wsManager.sendCommand(MessageType.SCROLL_TO, { y: 0, tab_id: tabId });
    if (typeof data.scrollX !== 'number') throw new Error('Missing scrollX');
    if (typeof data.scrollY !== 'number') throw new Error('Missing scrollY');
    if (!data.viewportWidth) throw new Error('Missing viewportWidth');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testSetStorage(tabId) {
  const name = 'set_storage';
  try {
    // Set a value
    const setData = await wsManager.sendCommand(MessageType.SET_STORAGE, { type: 'localStorage', action: 'set', key: '__cb_test__', value: 'hello', tab_id: tabId });
    if (!setData.success) throw new Error('set failed');
    // Delete the value
    const delData = await wsManager.sendCommand(MessageType.SET_STORAGE, { type: 'localStorage', action: 'delete', key: '__cb_test__', tab_id: tabId });
    if (!delData.success) throw new Error('delete failed');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testFillForm(tabId) {
  const name = 'fill_form';
  try {
    // Inject a test form
    await wsManager.sendCommand(MessageType.EXECUTE_JS, {
      code: "(() => { const f = document.createElement('form'); f.id='__cb_test_form'; f.innerHTML = '<input name=\"test\" id=\"__cb_test_input\" type=\"text\"><select id=\"__cb_test_select\"><option value=\"a\">A</option><option value=\"b\">B</option></select>'; document.body.appendChild(f); })()",
      tab_id: tabId,
    });
    await new Promise((r) => setTimeout(r, 200));

    const data = await wsManager.sendCommand(MessageType.FILL_FORM, {
      fields: [
        { selector: '#__cb_test_input', value: 'test123' },
        { selector: '#__cb_test_select', value: 'b' },
      ],
      tab_id: tabId,
    });
    if (!data.fields || !Array.isArray(data.fields)) throw new Error('Missing fields array');
    if (data.fields.length !== 2) throw new Error(`Expected 2 results, got ${data.fields.length}`);
    if (!data.fields[0].success) throw new Error('First field fill failed');
    if (!data.fields[1].success) throw new Error('Second field fill failed');

    // Cleanup
    await wsManager.sendCommand(MessageType.EXECUTE_JS, {
      code: "document.getElementById('__cb_test_form')?.remove()",
      tab_id: tabId,
    });
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testViewportResize(tabId) {
  const name = 'viewport_resize';
  try {
    const data = await wsManager.sendCommand(MessageType.VIEWPORT_RESIZE, { preset: 'desktop', tab_id: tabId });
    if (!data.requested) throw new Error('Missing requested');
    if (!data.actual) throw new Error('Missing actual');
    if (typeof data.actual.viewportWidth !== 'number') throw new Error('Missing viewportWidth');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testFullPageScreenshot(tabId) {
  const name = 'full_page_screenshot';
  try {
    const data = await wsManager.sendCommand(MessageType.FULL_PAGE_SCREENSHOT, { max_scrolls: 3, delay: 100, tab_id: tabId });
    if (!Array.isArray(data.captures)) throw new Error('Missing captures array');
    if (data.captures.length < 1) throw new Error('No captures');
    if (typeof data.scrollHeight !== 'number') throw new Error('Missing scrollHeight');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testHighlightElements(tabId) {
  const name = 'highlight_elements';
  try {
    const data = await wsManager.sendCommand(MessageType.HIGHLIGHT_ELEMENTS, { selector: 'h1', label: true, tab_id: tabId });
    if (typeof data.highlighted !== 'number') throw new Error('Missing highlighted count');
    // Cleanup
    await wsManager.sendCommand(MessageType.HIGHLIGHT_ELEMENTS, { remove: true, tab_id: tabId });
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testAccessibilityAudit(tabId) {
  const name = 'accessibility_audit';
  try {
    const data = await wsManager.sendCommand(MessageType.ACCESSIBILITY_AUDIT, { checks: ['all'], tab_id: tabId });
    if (!data.summary) throw new Error('Missing summary');
    if (typeof data.summary.total !== 'number') throw new Error('Missing total');
    if (!Array.isArray(data.violations)) throw new Error('violations not array');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testCheckLinks(tabId) {
  const name = 'check_links';
  try {
    const data = await wsManager.sendCommand(MessageType.CHECK_LINKS, { scope: 'all', max_links: 5, timeout: 5000, tab_id: tabId });
    if (typeof data.total !== 'number') throw new Error('Missing total');
    if (typeof data.checked !== 'number') throw new Error('Missing checked');
    if (!Array.isArray(data.results)) throw new Error('results not array');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testMeasureSpacing(tabId) {
  const name = 'measure_spacing';
  try {
    // example.com has h1 and p elements
    const data = await wsManager.sendCommand(MessageType.MEASURE_SPACING, { selector1: 'h1', selector2: 'p', tab_id: tabId });
    if (!data.element1) throw new Error('Missing element1');
    if (!data.element2) throw new Error('Missing element2');
    if (!data.spacing) throw new Error('Missing spacing');
    if (typeof data.spacing.centerDistance !== 'number') throw new Error('Missing centerDistance');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testWatchDom(tabId) {
  const name = 'watch_dom';
  try {
    // Start watcher (clear any previous)
    await wsManager.sendCommand(MessageType.WATCH_DOM, { clear: true, tab_id: tabId });

    // Trigger a DOM mutation via modify_dom
    await wsManager.sendCommand(MessageType.MODIFY_DOM, {
      selector: 'body',
      action: 'setAttribute',
      name: 'data-cb-dom-test',
      value: 'yes',
      tab_id: tabId,
    });
    await new Promise((r) => setTimeout(r, 300));

    // Read mutations
    const data = await wsManager.sendCommand(MessageType.WATCH_DOM, { clear: true, tab_id: tabId });
    if (typeof data.count !== 'number') throw new Error('Missing count');
    if (!Array.isArray(data.mutations)) throw new Error('mutations not array');
    if (data.count < 1) throw new Error('No mutations captured');

    // Stop and cleanup
    await wsManager.sendCommand(MessageType.WATCH_DOM, { stop: true, tab_id: tabId });
    await wsManager.sendCommand(MessageType.MODIFY_DOM, {
      selector: 'body',
      action: 'removeAttribute',
      name: 'data-cb-dom-test',
      tab_id: tabId,
    });
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testEmulateMedia(tabId) {
  const name = 'emulate_media';
  try {
    const data = await wsManager.sendCommand(MessageType.EMULATE_MEDIA, { colorScheme: 'dark', tab_id: tabId });
    if (!data.emulated) throw new Error('Missing emulated');
    // Reset
    await wsManager.sendCommand(MessageType.EMULATE_MEDIA, { reset: true, tab_id: tabId });
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testHover(tabId) {
  const name = 'hover';
  try {
    const data = await wsManager.sendCommand(MessageType.HOVER, { selector: 'h1', tab_id: tabId });
    if (!data.tagName) throw new Error('Missing tagName');
    if (!data.rect) throw new Error('Missing rect');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testPressKey(tabId) {
  const name = 'press_key';
  try {
    const data = await wsManager.sendCommand(MessageType.PRESS_KEY, { key: 'Escape', tab_id: tabId });
    if (!data.key) throw new Error('Missing key');
    if (data.key !== 'Escape') throw new Error(`Expected Escape, got ${data.key}`);
    if (!data.target) throw new Error('Missing target');
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

    // Original 8 tests
    await testGetPageInfo(testTabId);
    await testGetStorage(testTabId);
    await testGetPerformance(testTabId);
    await testQueryDom(testTabId);
    await testModifyDom(testTabId);
    await testInjectCss(testTabId);
    await testReadConsole(testTabId);
    await testMonitorNetwork(testTabId);

    // New 12 tests
    await testWaitForElement(testTabId);
    await testWaitForElementTimeout(testTabId);
    await testScrollTo(testTabId);
    await testSetStorage(testTabId);
    await testFillForm(testTabId);
    await testViewportResize(testTabId);
    await testFullPageScreenshot(testTabId);
    await testHighlightElements(testTabId);
    await testAccessibilityAudit(testTabId);
    await testCheckLinks(testTabId);
    await testMeasureSpacing(testTabId);
    await testWatchDom(testTabId);
    await testEmulateMedia(testTabId);
    await testHover(testTabId);
    await testPressKey(testTabId);

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
