#!/usr/bin/env node
/**
 * Test end-to-end per i nuovi DevTools tool di Chrome Bridge.
 *
 * Prerequisiti:
 * - Estensione Chrome caricata e connessa
 * - Server MCP NON in esecuzione sulla stessa porta (questo script avvia il
 *   proprio WSManager): con un primary attivo usa CHROME_BRIDGE_PORT=8799
 *
 * Uso: node test/test-devtools.js
 *      CHROME_BRIDGE_PORT=8799 node test/test-devtools.js --launch [--headless]
 */

import { WSManager } from '../server/ws-manager.js';
import { MessageType } from '../server/protocol.js';
import { launchBrowser } from '../server/launcher.js';
import { registerTools } from '../server/tools.js';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';

// Con un'altra sessione che tiene la 8765 il test non partiva mai: la porta
// viene dall'ambiente, e con --launch il browser lo apre lo script stesso
// (Chromium dedicato con extension/ unpacked), come fa il server.
const PORT = parseInt(process.env.CHROME_BRIDGE_PORT || '8765', 10);
const LAUNCH = process.argv.includes('--launch');
const HEADLESS = process.argv.includes('--headless');
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

    // 1.24.0: un Error passato a console.error arriva con il suo stack, non come "{}".
    await wsManager.sendCommand(MessageType.EXECUTE_JS, {
      code: "(() => { const s = document.createElement('script'); s.textContent = \"console.error('__cb_err__', new Error('__cb_boom__'))\"; document.head.appendChild(s); s.remove(); })()",
      tab_id: tabId,
    });
    await new Promise((r) => setTimeout(r, 300));
    const errs = await wsManager.sendCommand(MessageType.READ_CONSOLE, { clear: true, level: 'error', tab_id: tabId });
    const errArgs = errs.messages.find((m) => m.args?.[0] === '__cb_err__')?.args ?? [];
    if (!/^Error: __cb_boom__\n\s+at /.test(errArgs[1] ?? '')) throw new Error(`Error arg without stack: ${JSON.stringify(errArgs[1])}`);
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

// 1.25.0: una scheda aperta dall'agente registra la rete fin dal caricamento.
// Prima la prima monitor_network tornava vuota e la richiesta fallita
// all'avvio (il caso tipico da debuggare) non si vedeva.
// 1.25.0: il cursore di read_console restituisce solo le voci nuove, senza cancellare.
async function testConsoleCursor(tabId) {
  const name = 'read_console: since cursor returns only newer entries';
  const log = (msg) => wsManager.sendCommand(MessageType.EXECUTE_JS, {
    code: `(() => { const s = document.createElement('script'); s.textContent = "console.log('${msg}')"; document.head.appendChild(s); s.remove(); })()`,
    tab_id: tabId,
  });
  try {
    await log('__cb_cursor_a__');
    await new Promise((r) => setTimeout(r, 200));
    const first = await wsManager.sendCommand(MessageType.READ_CONSOLE, { tab_id: tabId });
    if (!first.cursor || !String(first.cursor).includes(':')) throw new Error(`no cursor: ${JSON.stringify(first.cursor)}`);
    await log('__cb_cursor_b__');
    await new Promise((r) => setTimeout(r, 200));
    const next = await wsManager.sendCommand(MessageType.READ_CONSOLE, { since: first.cursor, tab_id: tabId });
    const texts = next.messages.map((m) => (m.args ?? []).join(' '));
    if (!texts.some((t) => t.includes('__cb_cursor_b__'))) throw new Error('new entry missing');
    if (texts.some((t) => t.includes('__cb_cursor_a__'))) throw new Error(`old entry repeated: ${JSON.stringify(texts)}`);
    const again = await wsManager.sendCommand(MessageType.READ_CONSOLE, { tab_id: tabId });
    if (!again.messages.some((m) => (m.args ?? []).join(' ').includes('__cb_cursor_a__'))) throw new Error('since deleted entries');
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

async function testNetworkFromLoad() {
  const name = 'monitor_network: requests made during page load are captured';
  const http = createHttpServer((req, res) => {
    if (req.url === '/api/boot') { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end("<!doctype html><title>boot</title><script>fetch('/api/boot').catch(() => {})</script>");
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  let tabId;
  try {
    const nav = await wsManager.sendCommand(MessageType.NAVIGATE, { url: `http://127.0.0.1:${http.address().port}/` });
    tabId = nav?.tabId;
    await new Promise((r) => setTimeout(r, 500));
    const data = await wsManager.sendCommand(MessageType.MONITOR_NETWORK, { tab_id: tabId });
    const hit = (data.requests ?? []).find((q) => String(q.url).endsWith('/api/boot'));
    if (!hit) throw new Error(`load-time fetch missing: ${JSON.stringify((data.requests ?? []).map((q) => q.url))}`);
    if (hit.status !== 404) throw new Error(`status ${hit.status}, expected 404`);
    ok(name);
  } catch (e) {
    fail(name, e.message);
  } finally {
    if (tabId) await wsManager.sendCommand(MessageType.TAB_ACTION, { action: 'close', tab_id: tabId }).catch(() => {});
    http.close();
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

async function testWaitForFunction(tabId) {
  {
    const name = 'wait_for_function (satisfied)';
    try {
      const data = await wsManager.sendCommand(MessageType.WAIT_FOR_FUNCTION, {
        expression: 'document.readyState === "complete" || document.readyState === "interactive"',
        timeout: 5000,
        tab_id: tabId,
      });
      if (data.satisfied !== true) throw new Error(`satisfied=${data.satisfied}`);
      if (typeof data.elapsed !== 'number') throw new Error('Missing elapsed');
      ok(name);
    } catch (e) {
      fail(name, e.message);
    }
  }
  {
    const name = 'wait_for_function (timeout)';
    try {
      const data = await wsManager.sendCommand(MessageType.WAIT_FOR_FUNCTION, {
        expression: 'window.__never_exists_xyz === 42',
        timeout: 1200,
        polling_ms: 100,
        tab_id: tabId,
      });
      if (data.satisfied !== false) throw new Error(`satisfied=${data.satisfied}`);
      if (data.elapsed < 1200) throw new Error(`elapsed=${data.elapsed} < 1200`);
      ok(name);
    } catch (e) {
      fail(name, e.message);
    }
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
    // stitch=true (default) restituisce { images } (segmenti), stitch=false { captures }
    const hasImages = Array.isArray(data.images) && data.images.length >= 1;
    const hasCaptures = Array.isArray(data.captures) && data.captures.length >= 1;
    if (!hasImages && !hasCaptures) throw new Error('Missing images or captures array');
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

async function testCollectLinks(tabId) {
  const name = 'collect_links';
  try {
    // L'estensione raccoglie solo i link dal DOM; la verifica HTTP avviene lato server (link-checker.js)
    const data = await wsManager.sendCommand(MessageType.COLLECT_LINKS, { scope: 'all', max_links: 5, tab_id: tabId });
    if (!Array.isArray(data.links)) throw new Error('links not array');
    if (typeof data.totalAnchors !== 'number') throw new Error('Missing totalAnchors');
    if (data.links.length > 0 && (typeof data.links[0].url !== 'string' || typeof data.links[0].text !== 'string')) {
      throw new Error('link entry missing url/text');
    }
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

// --- 1.16.0: comandi nuovi del service worker ---
// Tutti su example.com: niente form, quindi read_form vuoto e keyboard_walk
// con un solo link; il test verifica la FORMA della risposta e i casi limite
// (timeout di handoff, watch che non spara), non l'esito su una pagina vera.

async function testReadForm(tabId) {
  const name = 'read_form';
  try {
    const data = await wsManager.sendCommand(MessageType.READ_FORM, { tab_id: tabId });
    if (!Array.isArray(data.controls)) throw new Error('Missing controls');
    if (typeof data.count !== 'number') throw new Error('Missing count');
    ok(name);
  } catch (e) { fail(name, e.message); }
}

async function testKeyboardWalk(tabId) {
  const name = 'keyboard_walk';
  try {
    const data = await wsManager.sendCommand(MessageType.KEYBOARD_WALK, { max_steps: 5, tab_id: tabId });
    if (!Array.isArray(data.steps)) throw new Error('Missing steps');
    if (data.total_focusable < 1) throw new Error('example.com has one link: expected ≥1 focusable');
    if (!data.steps[0].selector) throw new Error('Step without selector');
    ok(name);
  } catch (e) { fail(name, e.message); }
}

async function testListAssetsAndTiming(tabId) {
  const name = 'list_assets + resource_timing';
  try {
    const assets = await wsManager.sendCommand(MessageType.LIST_ASSETS, { tab_id: tabId });
    if (!String(assets.page).startsWith(FIXTURE_URL)) throw new Error(`Unexpected page ${assets.page}`);
    const timing = await wsManager.sendCommand(MessageType.RESOURCE_TIMING, { tab_id: tabId });
    if (!Array.isArray(timing.entries) || !timing.navigation) throw new Error('Missing entries/navigation');
    ok(name);
  } catch (e) { fail(name, e.message); }
}

async function testDiffFromFile(tabId) {
  const name = 'screenshot_diff baseline from image';
  try {
    const shot = await wsManager.sendCommand(MessageType.SCREENSHOT, { tab_id: tabId });
    await wsManager.sendCommand(MessageType.SCREENSHOT_DIFF, { action: 'baseline', name: 'e2e', image_b64: shot.image, tab_id: tabId });
    const cmp = await wsManager.sendCommand(MessageType.SCREENSHOT_DIFF, { action: 'compare', name: 'e2e', tab_id: tabId });
    if (cmp.reason === 'size_mismatch') throw new Error(`size mismatch: ${JSON.stringify(cmp)}`);
    if (typeof cmp.diff_percent !== 'number') throw new Error('Missing diff_percent');
    await wsManager.sendCommand(MessageType.SCREENSHOT_DIFF, { action: 'clear', name: 'e2e', tab_id: tabId });
    ok(name);
  } catch (e) { fail(name, e.message); }
}

async function testWatch(tabId) {
  const name = 'watch add/list/poll/remove';
  try {
    const add = await wsManager.sendCommand(MessageType.WATCH, { action: 'add', name: 'e2e', text: 'never-on-this-page', interval_s: 30, expires_min: 2, tab_id: tabId });
    if (add.added !== 'e2e' || add.initial?.text_found !== false) throw new Error(`Unexpected add: ${JSON.stringify(add)}`);
    const list = await wsManager.sendCommand(MessageType.WATCH, { action: 'list' });
    if (!list.watches.some((w) => w.name === 'e2e')) throw new Error('Watch not listed');
    const poll = await wsManager.sendCommand(MessageType.WATCH, { action: 'poll', name: 'e2e', since: 0 });
    if (poll.events.length !== 0) throw new Error('Unexpected event before any check');
    const rm = await wsManager.sendCommand(MessageType.WATCH, { action: 'remove', name: 'e2e' });
    if (!rm.removed) throw new Error('Not removed');
    ok(name);
  } catch (e) { fail(name, e.message); }
}

async function testObserve(tabId) {
  const name = 'observe start/click/stop';
  try {
    await wsManager.sendCommand(MessageType.OBSERVE, { action: 'start', name: 'e2e', tab_id: tabId });
    await wsManager.sendCommand(MessageType.CLICK, { selector: 'a', tab_id: tabId });
    await new Promise((r) => setTimeout(r, 1500));
    const stop = await wsManager.sendCommand(MessageType.OBSERVE, { action: 'stop' });
    if (stop.stopped !== 'e2e') throw new Error('Not stopped');
    const cmds = stop.steps.map((st) => st.command);
    if (cmds[0] !== 'navigate') throw new Error(`First step should be navigate, got ${cmds[0]}`);
    if (!cmds.includes('click')) throw new Error(`Click not observed: ${cmds.join(',')}`);
    ok(name);
  } catch (e) { fail(name, e.message); }
}

async function testHandoffTimeout(tabId) {
  const name = 'handoff (timeout)';
  try {
    const data = await wsManager.sendCommand(MessageType.HANDOFF, { message: 'e2e', timeout: 1500, tab_id: tabId });
    if (data.action !== 'timeout' || data.done !== false) throw new Error(`Expected timeout, got ${JSON.stringify(data)}`);
    ok(name);
  } catch (e) { fail(name, e.message); }
}

async function testPageFingerprintClickEffect(tabId) {
  const name = 'page_fingerprint + click effect (details opens)';
  try {
    await wsManager.sendCommand(MessageType.EXECUTE_JS, { code: "(() => { const d = document.createElement('details'); d.id = '__cb_fp'; d.innerHTML = '<summary>toggle</summary><p>body</p>'; document.body.appendChild(d); return true; })()", tab_id: tabId });
    const before = await wsManager.sendCommand(MessageType.PAGE_FINGERPRINT, { tab_id: tabId });
    for (const k of ['nodes', 'text', 'open', 'expanded', 'checked', 'dialogs']) if (typeof before[k] !== 'number') throw new Error(`Missing ${k}: ${JSON.stringify(before)}`);
    // Il click apre subito il details; un nodo arriva 40 ms dopo, come un
    // framework che aggiorna fuori dal click. settle deve aspettarlo.
    await wsManager.sendCommand(MessageType.EXECUTE_JS, { code: "(() => { document.querySelector('#__cb_fp summary').addEventListener('click', () => setTimeout(() => document.body.appendChild(document.createElement('aside')), 40)); return true; })()", tab_id: tabId });
    await wsManager.sendCommand(MessageType.CLICK, { selector: '#__cb_fp summary', tab_id: tabId });
    const after = await wsManager.sendCommand(MessageType.PAGE_FINGERPRINT, { tab_id: tabId, settle: { quiet_ms: 50, max_ms: 250 } });
    if (after.open !== before.open + 1) throw new Error(`open ${before.open} -> ${after.open}`);
    if (typeof after.settled_ms !== 'number' || after.settled_ms > 250) throw new Error(`settled_ms ${after.settled_ms}`);
    if (!after.hidden && after.nodes < before.nodes + 1) throw new Error(`late node missed: nodes ${before.nodes} -> ${after.nodes}, settled_ms ${after.settled_ms}`);
    ok(name);
  } catch (e) { fail(name, e.message); }
}

async function testTypeTextReadback(tabId) {
  const name = 'type_text value_after/mismatch';
  try {
    await wsManager.sendCommand(MessageType.EXECUTE_JS, { code: "(() => { const i = document.createElement('input'); i.id = '__cb_rb'; document.body.appendChild(i); return true; })()", tab_id: tabId });
    const data = await wsManager.sendCommand(MessageType.TYPE_TEXT, { selector: '#__cb_rb', text: 'Mario Rossi', tab_id: tabId });
    if (data.value_after !== 'Mario Rossi' || data.mismatch !== false) throw new Error(JSON.stringify(data));
    ok(name);
  } catch (e) { fail(name, e.message); }
}

async function testHandoffAskViaBanner(tabId) {
  const name = 'handoff ask (typed reply through the banner)';
  try {
    const p = wsManager.sendCommand(MessageType.HANDOFF, { message: 'e2e ask', ask: true, timeout: 8000, tab_id: tabId });
    await new Promise((r) => setTimeout(r, 600));
    await wsManager.sendCommand(MessageType.TYPE_TEXT, { selector: '#cb-handoff-host >>> input.ask', text: 'the blue one', tab_id: tabId });
    // force: dal documento il bottone nello shadow root risulta coperto dal suo host
    await wsManager.sendCommand(MessageType.CLICK, { selector: '#cb-handoff-host >>> button.done', force: true, tab_id: tabId });
    const data = await p;
    if (data.action !== 'done' || data.answer !== 'the blue one') throw new Error(JSON.stringify(data));
    ok(name);
  } catch (e) { fail(name, e.message); }
}

async function testHandoffMultiPick(tabId) {
  const name = 'handoff pick_max=2 (two elements, then done)';
  try {
    await wsManager.sendCommand(MessageType.EXECUTE_JS, { code: "(() => { for (const id of ['__cb_p1', '__cb_p2']) { const b = document.createElement('button'); b.id = id; b.textContent = id; b.style.cssText = 'position:fixed;left:20px;top:' + (id.endsWith('1') ? 300 : 360) + 'px;z-index:2147483000'; document.body.appendChild(b); } return true; })()", tab_id: tabId });
    const p = wsManager.sendCommand(MessageType.HANDOFF, { message: 'e2e pick', pick_element: true, pick_max: 2, timeout: 8000, tab_id: tabId });
    await new Promise((r) => setTimeout(r, 600));
    await wsManager.sendCommand(MessageType.CLICK, { selector: '#cb-handoff-host >>> button.pick', force: true, tab_id: tabId });
    await new Promise((r) => setTimeout(r, 200));
    // Clic con coordinate vere: il picker legge elementFromPoint(clientX, clientY)
    await wsManager.sendCommand(MessageType.EXECUTE_JS, { code: "(() => { for (const id of ['__cb_p1', '__cb_p2']) { const el = document.getElementById(id); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5 })); } return true; })()", tab_id: tabId });
    const data = await p;
    if (data.action !== 'picked' || !Array.isArray(data.picked_all) || data.picked_all.length !== 2) throw new Error(JSON.stringify(data));
    if (data.picked_all[1].selector !== '#__cb_p2' || data.picked.selector !== '#__cb_p1') throw new Error(JSON.stringify(data.picked_all));
    ok(name);
  } catch (e) { fail(name, e.message); }
}

async function testFindTextSplitLabel(tabId) {
  const name = 'find_text on a label split across nodes and &nbsp;';
  try {
    await wsManager.sendCommand(MessageType.EXECUTE_JS, { code: "(() => { const u = document.createElement('ul'); u.innerHTML = '<li id=\"__cb_ft\"><span>Prestazioni</span> e <b>clic</b></li><li id=\"__cb_ft2\">Dati&nbsp;demografici</li>'; document.body.appendChild(u); return true; })()", tab_id: tabId });
    const a = await wsManager.sendCommand(MessageType.FIND_TEXT, { text: 'Prestazioni e clic', tab_id: tabId });
    const b = await wsManager.sendCommand(MessageType.FIND_TEXT, { text: 'dati demografici', tab_id: tabId });
    if (a.count !== 1 || a.matches[0].selector !== '#__cb_ft') throw new Error(JSON.stringify(a));
    if (b.count !== 1 || b.matches[0].selector !== '#__cb_ft2') throw new Error(JSON.stringify(b));
    ok(name);
  } catch (e) { fail(name, e.message); }
}

async function testScrollUntilInnerContainer(tabId) {
  const name = 'scroll until inside an inner container (document does not scroll)';
  try {
    await wsManager.sendCommand(MessageType.EXECUTE_JS, { code: "(() => { document.documentElement.style.overflow = 'hidden'; document.body.style.overflow = 'hidden'; const d = document.createElement('div'); d.id = '__cb_sc'; d.style.cssText = 'position:fixed;inset:0;overflow-y:auto;background:#fff;z-index:2147483000'; d.innerHTML = '<div style=\"height:5000px\">tall</div>'; document.body.appendChild(d); return true; })()", tab_id: tabId });
    const data = await wsManager.sendCommand(MessageType.SCROLL_UNTIL, { until: 'no_new_content', max_scrolls: 3, settle_ms: 100, tab_id: tabId });
    if (data.container !== '#__cb_sc' || !(data.finalScrollY > 0)) throw new Error(JSON.stringify(data));
    ok(name);
  } catch (e) { fail(name, e.message); }
  await wsManager.sendCommand(MessageType.EXECUTE_JS, { code: "(() => { document.getElementById('__cb_sc')?.remove(); document.documentElement.style.overflow = ''; document.body.style.overflow = ''; return true; })()", tab_id: tabId }).catch(() => {});
}

async function testGetInteractivesLabels(tabId) {
  const name = 'get_interactives names fields by <label>, wrapping label, aria-labelledby';
  try {
    await wsManager.sendCommand(MessageType.EXECUTE_JS, { code: "(() => { const f = document.createElement('form'); f.id = '__cb_lbl'; f.innerHTML = '<label>Customer name: <input name=\"custname\"></label><label for=\"__cb_tel\">Telephone</label><input id=\"__cb_tel\" type=\"tel\"><span id=\"__cb_dl\">Delivery time</span><input aria-labelledby=\"__cb_dl\" type=\"time\"><label><input type=\"radio\" name=\"size\" value=\"small\"> Small</label><label><input type=\"checkbox\" value=\"bacon\"> Bacon</label><label>Size <select><option>L</option></select></label><button>Submit order</button>'; document.body.appendChild(f); return true; })()", tab_id: tabId });
    const data = await wsManager.sendCommand(MessageType.GET_INTERACTIVES, { scope: '#__cb_lbl', tab_id: tabId });
    const texts = data.elements.map((e) => e.text);
    const want = ['Customer name:', 'Telephone', 'Delivery time', 'Small', 'Bacon', 'Size', 'Submit order'];
    if (JSON.stringify(texts) !== JSON.stringify(want)) throw new Error(JSON.stringify(texts));
    ok(name);
  } catch (e) { fail(name, e.message); }
  await wsManager.sendCommand(MessageType.EXECUTE_JS, { code: "(() => { document.getElementById('__cb_lbl')?.remove(); return true; })()", tab_id: tabId }).catch(() => {});
}

async function testWaitForTextHiddenWindow() {
  const name = 'wait_for text in a minimized window: answers within its timeout, says page_hidden';
  let winTab = null;
  try {
    winTab = await wsManager.sendCommand(MessageType.CREATE_TAB, { url: FIXTURE_URL, new_window: true });
    await new Promise((r) => setTimeout(r, 1000));
    await wsManager.sendCommand(MessageType.VIEWPORT_RESIZE, { state: 'minimized', tab_id: winTab.id });
    await new Promise((r) => setTimeout(r, 800));
    const info = await wsManager.sendCommand(MessageType.GET_PAGE_INFO, { tab_id: winTab.id });
    const t0 = Date.now();
    const data = await wsManager.sendCommand(MessageType.WAIT_FOR_TEXT, { text: 'never-there-xyz', timeout: 2000, tab_id: winTab.id });
    const took = Date.now() - t0;
    if (data.found !== false || took > 4500) throw new Error(`took ${took}ms: ${JSON.stringify(data)}`);
    if (info.visibility === 'hidden' && data.page_hidden !== true) throw new Error(`page hidden but no page_hidden: ${JSON.stringify(data)}`);
    log(`visibility=${info.visibility}, page_hidden=${data.page_hidden ?? false}, ${took}ms`);
    ok(name);
  } catch (e) { fail(name, e.message); }
  if (winTab?.id) await wsManager.sendCommand(MessageType.TAB_ACTION, { action: 'close', tab_id: winTab.id }).catch(() => {});
}

// 1.23.4 (test Windows del 27/09): due successi falsi, su ogni OS.
async function expectElementNotFound(name, type, params, tabId) {
  try {
    let data;
    try {
      data = await wsManager.sendCommand(type, { ...params, tab_id: tabId });
    } catch (e) {
      if (!e.message.includes(`Element not found: ${params.selector}`)) throw new Error(`wrong error: ${e.message}`);
      ok(name);
      return;
    }
    throw new Error(`no error, got ${JSON.stringify(data)}`);
  } catch (e) { fail(name, e.message); }
}

async function testElementCommandsNoMatch(tabId) {
  const sel = '#__cb_nothing_here';
  await expectElementNotFound('click on a selector with no match fails, does not report clicked', MessageType.CLICK, { selector: sel }, tabId);
  await expectElementNotFound('type_text on a selector with no match fails, does not report typed', MessageType.TYPE_TEXT, { selector: sel, text: 'x' }, tabId);
  await expectElementNotFound('hover on a selector with no match fails, does not report hovered', MessageType.HOVER, { selector: sel }, tabId);
  await expectElementNotFound('press_key on a selector with no match fails, does not report pressed', MessageType.PRESS_KEY, { key: 'Enter', selector: sel }, tabId);
}

// Suite negativa a livello di tool MCP (analisi 28/09 §3 A.1): ogni tool che
// prende un selettore, con un selettore che non trova niente, deve dirlo —
// errore o esito esplicito — e mai riportare un successo.
const NO_MATCH = /"count":\s*0|total=0|"tables_found":\s*0|"dragged":\s*false|not found|no match|no element|matched 0|count[=:]\s*0|\b0 (elements|matches|items|records)|"(found|passed|met|success|submitted)":\s*false|timed? ?out|NOT SUBMITTED|\bFAIL/i;
async function testToolsNoMatch(tabId) {
  const handlers = new Map();
  registerTools({ tool: (n, _d, _s, ...rest) => handlers.set(n, rest[rest.length - 1]) }, wsManager, 'all');
  const sel = '#__cb_nothing_here';
  const cases = [
    ['click', { selector: sel }], ['type_text', { selector: sel, text: 'x' }], ['hover', { selector: sel }],
    ['press_key', { key: 'Enter', selector: sel }], ['query_dom', { selector: sel }], ['get_css_styles', { selector: sel }],
    ['modify_dom', { selector: sel, action: 'setTextContent', value: 'x' }], ['wait_for', { condition: 'element', selector: sel, timeout: 300 }],
    ['scroll', { action: 'to', selector: sel }], ['watch_dom', { selector: sel }], ['element_screenshot', { selector: sel }], ['measure_spacing', { selector1: sel, selector2: 'body' }],
    ['read_form', { selector: sel }], ['extract_table', { selector: sel }], ['extract', { item_selector: sel, fields: { t: {} } }],
    ['assert', { selector: sel }], ['upload_file', { selector: sel, path: fileURLToPath(import.meta.url) }],
    ['drag_and_drop', { source_selector: sel, target_selector: 'body' }],
    ['fill_form', { fields: [{ selector: sel, value: 'x' }] }],
    ['fill_form', { fields: [], submit_selector: sel }],
  ];
  for (const [tool, args] of cases) {
    const name = `tool ${tool} with no match: says so, no success (${Object.keys(args).join(',')})`;
    const h = handlers.get(tool);
    if (!h) { fail(name, 'tool not registered'); continue; }
    try {
      let text;
      try {
        const res = await h({ ...args, tab_id: tabId });
        text = (res?.content ?? []).map((c) => c.text ?? `[${c.type}]`).join('\n');
        if (process.env.PROBE) console.log(`PROBE ${tool}: ${res?.isError ? '(isError) ' : ''}${text.slice(0, 300).replace(/\n/g, ' | ')}`);
        if (res?.isError || NO_MATCH.test(text)) { ok(name); continue; }
      } catch (e) {
        if (process.env.PROBE) console.log(`PROBE ${tool}: throws ${e.message.slice(0, 200)}`);
        ok(name); continue;
      }
      throw new Error(`reported as success: ${text.slice(0, 200)}`);
    } catch (e) { fail(name, e.message); }
  }
}

// Input fidato via chrome.debugger: la pagina vede isTrusted=true, e Enter su
// un campo invia il form (effetto di default che un evento sintetico non ha).
async function testTrustedInput(tabId) {
  const name = 'trusted click, type and key: isTrusted events, Enter submits';
  try {
    await wsManager.sendCommand(MessageType.EXECUTE_JS, { code: `(() => {
      const f = document.createElement('form'); f.id = '__cb_tf'; f.action = 'javascript:void 0';
      f.innerHTML = '<input id="__cb_ti"><button id="__cb_tb" type="button">b</button>';
      document.body.appendChild(f);
      window.__cbT = { click: null, key: null, submitted: false };
      f.querySelector('#__cb_tb').addEventListener('click', (e) => { window.__cbT.click = e.isTrusted; });
      f.querySelector('#__cb_ti').addEventListener('keydown', (e) => { window.__cbT.key = e.isTrusted; });
      f.addEventListener('submit', (e) => { e.preventDefault(); window.__cbT.submitted = true; });
      return true; })()`, tab_id: tabId });
    const c = await wsManager.sendCommand(MessageType.CLICK, { selector: '#__cb_tb', trusted: true, tab_id: tabId });
    if (!c.trusted || !c.clicked) throw new Error(`click: ${JSON.stringify(c)}`);
    const t = await wsManager.sendCommand(MessageType.TYPE_TEXT, { selector: '#__cb_ti', text: 'ciao fidato', mode: 'trusted', tab_id: tabId });
    if (t.value_after !== 'ciao fidato' || t.mismatch) throw new Error(`type: ${JSON.stringify(t)}`);
    await wsManager.sendCommand(MessageType.PRESS_KEY, { key: 'Enter', selector: '#__cb_ti', trusted: true, tab_id: tabId });
    const r = await wsManager.sendCommand(MessageType.EXECUTE_JS, { code: 'JSON.stringify(window.__cbT)', tab_id: tabId });
    const st = JSON.parse(r.result);
    if (st.click !== true || st.key !== true || st.submitted !== true) throw new Error(`page saw ${r.result}`);
    ok(name);
  } catch (e) { fail(name, e.message); }
}

async function closedPort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

async function testNavigateConnectionRefused(tabId) {
  const name = 'navigate to a refused connection reports net::ERR_CONNECTION_REFUSED (given tab and new tab)';
  const url = `http://127.0.0.1:${await closedPort()}/`;
  let newTabId = null;
  try {
    for (const params of [{ url, tab_id: tabId }, { url }]) {
      let data;
      try {
        data = await wsManager.sendCommand(MessageType.NAVIGATE, params);
      } catch (e) {
        if (!/^net::ERR_CONNECTION_REFUSED loading http:\/\/127\.0\.0\.1:\d+\/ \(tab \d+/.test(e.message)) throw new Error(`wrong error: ${e.message}`);
        if (!params.tab_id) newTabId = Number(e.message.match(/\(tab (\d+)/)[1]);
        continue;
      }
      if (!params.tab_id) newTabId = data?.tabId;
      throw new Error(`no error with ${params.tab_id ? 'tab_id' : 'a new tab'}: ${JSON.stringify(data)}`);
    }
    ok(name);
  } catch (e) { fail(name, e.message); }
  if (newTabId) await wsManager.sendCommand(MessageType.TAB_ACTION, { action: 'close', tab_id: newTabId }).catch(() => {});
}

// --- Main ---

// Unreleased: get_css_styles. example.com: <style>body{background:#eee;width:60vw;
// margin:15vh auto;font-family:system-ui,sans-serif}h1{font-size:1.5em}…</style>
async function testGetCssStyles(tabId) {
  const name = 'get_css_styles: winner with sheet and rule, shorthand expanded, inherited from body';
  try {
    // I test precedenti lasciano la scheda dove capita: la pagina va scelta qui.
    await wsManager.sendCommand(MessageType.NAVIGATE, { url: FIXTURE_URL, tab_id: tabId });
    await new Promise((r) => setTimeout(r, 500));
    const body = await wsManager.sendCommand(MessageType.GET_CSS_STYLES, { selector: 'body', properties: ['width', 'margin'], tab_id: tabId });
    const width = body.properties?.width;
    if (!width) throw new Error(`no width: ${JSON.stringify(body).slice(0, 300)}`);
    if (width.value !== '60vw') throw new Error(`width.value ${width.value}, expected 60vw`);
    if (width.source?.selector !== 'body') throw new Error(`source ${JSON.stringify(width.source)}`);
    if (!/^<style>/.test(width.source.sheet)) throw new Error(`sheet ${width.source.sheet}`);
    if (!/px$/.test(width.computed)) throw new Error(`computed ${width.computed}`);
    const top = body.properties['margin-top'];
    if (top?.value !== '15vh') throw new Error(`margin shorthand not expanded: ${JSON.stringify(top)}`);
    const h1 = await wsManager.sendCommand(MessageType.GET_CSS_STYLES, { selector: 'h1', include_inherited: true, tab_id: tabId });
    if (h1.properties?.['font-size']?.value !== '1.5em') throw new Error(`h1 font-size ${JSON.stringify(h1.properties?.['font-size'])}`);
    if (h1.properties?.['font-family']?.inherited_from !== 'body') throw new Error(`font-family ${JSON.stringify(h1.properties?.['font-family'])}`);
    log(`body width ${width.value} (${width.computed}) from ${width.source.sheet} rule ${width.source.rule}; h1 font-family inherited from ${h1.properties['font-family'].inherited_from}`);
    ok(name);
  } catch (e) {
    fail(name, e.message);
  }
}

// 1.27.0: animations e frames (gruppo perf) su bench/motion.html.
async function testMotion() {
  const tab = await wsManager.sendCommand(MessageType.CREATE_TAB, { url: `${FIXTURE_URL}motion`, active: true });
  const tab_id = tab.id;
  await new Promise((r) => setTimeout(r, 800));
  const motion = (op, extra = {}) => wsManager.sendCommand(MessageType.MOTION, { op, tab_id, ...extra });
  const windowWith = async (selector, ms, trusted = false) => {
    await motion('start');
    await wsManager.sendCommand(MessageType.CLICK, { selector, button: 'left', count: 1, ...(trusted && { trusted: true }), tab_id });
    await new Promise((r) => setTimeout(r, ms));
    return motion('stop');
  };
  try {
    const snap = await motion('snapshot');
    const spin = snap.animations.find((a) => a.name === 'spin');
    if (!spin || spin.iterations !== 'infinite' || !spin.composited_estimate) throw new Error(`spin: ${JSON.stringify(spin)}`);
    const grow = snap.animations.find((a) => a.name === 'grow');
    if (grow?.timeline !== 'scroll') throw new Error(`grow timeline: ${JSON.stringify(grow)}`);
    ok('animations snapshot (CSS infinita, timeline di scroll)');
  } catch (e) { fail('animations snapshot', e.message); }
  try {
    const rec = await windowWith('#pop', 600);
    const pop = rec.animations.list.find((a) => a.kind === 'Animation');
    if (!pop || !String(pop.easing).startsWith('linear(')) throw new Error(`pop: ${JSON.stringify(pop)}`);
    ok('animations window (Web Animation con linear())');
  } catch (e) { fail('animations window', e.message); }
  try {
    const rec = await windowWith('#busy', 600, true);
    if (!rec.support.long_animation_frame) throw new Error('LoAF non supportato');
    if (rec.long_frames.count < 1) throw new Error(`nessun fotogramma lungo: ${JSON.stringify(rec.long_frames)}`);
    if (!rec.frames.count) throw new Error('nessun fotogramma rAF');
    if (!(rec.interactions.inp_ms >= 100) || rec.interactions.worst.selector !== '#busy') throw new Error(`INP: ${JSON.stringify(rec.interactions)}`);
    ok(`frames: fotogramma lungo ${rec.long_frames.worst[0].duration_ms} ms, script ${rec.long_frames.worst[0].scripts[0]?.invoker ?? '?'}, INP ${rec.interactions.inp_ms}`);
  } catch (e) { fail('frames long frame', e.message); }
  try {
    const rec = await windowWith('#shift', 1200);
    if (!(rec.layout_shifts.cls > 0)) throw new Error(`CLS: ${JSON.stringify(rec.layout_shifts)}`);
    ok(`frames: layout shift CLS ${rec.layout_shifts.cls} su ${rec.layout_shifts.top[0]?.sources[0]?.selector}`);
  } catch (e) { fail('frames layout shift', e.message); }
  try {
    const rec = await windowWith('#vt', 800);
    if (!rec.animations.summary.view_transitions) throw new Error(`nessuna View Transition: ${JSON.stringify(rec.animations.summary)}`);
    ok(`animations: ${rec.animations.summary.view_transitions} animazioni di View Transition`);
  } catch (e) { fail('animations view transition', e.message); }
  try {
    await motion('stop').then(() => { throw new Error('stop senza start accettato'); }, (err) => {
      if (!/No recording/.test(err.message)) throw err;
    });
    ok('frames: stop senza start rifiutato');
  } catch (e) { fail('frames stop senza start', e.message); }
  // emulate_media via debugger: le @media del sito valgono davvero.
  const emulate = (p) => wsManager.sendCommand(MessageType.EMULATE_MEDIA, { tab_id, ...p });
  try {
    const on = await emulate({ reducedMotion: 'reduce', via: 'debugger' });
    if (on.via !== 'debugger' || on.emulated.reducedMotion !== 'reduce') throw new Error(JSON.stringify(on));
    const snap = await motion('snapshot');
    const names = snap.animations.map((a) => a.name);
    if (!snap.prefers_reduced_motion || names.includes('spin') || !names.includes('grow')) throw new Error(`con reduce: ${names} rm=${snap.prefers_reduced_motion}`);
    ok('emulate_media via debugger: la regola reduce del sito toglie spin, grow resta');
  } catch (e) { fail('emulate_media via debugger reduce', e.message); }
  try {
    const work = async () => (await wsManager.sendCommand(MessageType.EXECUTE_JS, {
      code: '(() => { const t = performance.now(); let x = 0; for (let i = 0; i < 2e7; i++) x += i % 7; return performance.now() - t; })()', tab_id,
    })).result;
    const before = await work();
    await emulate({ cpu_throttle: 4 });
    await windowWith('#busy', 300, true);
    const still = await motion('snapshot');
    if (still.prefers_reduced_motion !== true) throw new Error('il click fidato ha staccato il debugger: emulazione persa');
    const after = await work();
    if (!(after > before * 2)) throw new Error(`CPU x4 non visibile: ${Math.round(before)} → ${Math.round(after)} ms`);
    ok(`emulate_media: reduce resta dopo un click fidato, CPU x4 porta un lavoro fisso da ${Math.round(before)} a ${Math.round(after)} ms`);
  } catch (e) { fail('emulate_media con input fidato e CPU', e.message); }
  try {
    const off = await emulate({ reset: true });
    if (!off.debugger_released) throw new Error(JSON.stringify(off));
    const snap = await motion('snapshot');
    if (snap.prefers_reduced_motion || !snap.animations.some((a) => a.name === 'spin')) throw new Error('reset non ha tolto reduce');
    ok('emulate_media reset: debugger staccato, spin di nuovo in corso');
  } catch (e) { fail('emulate_media reset', e.message); }
  try {
    await emulate({ network: '3g', via: 'page' }).then(() => { throw new Error('network via page accettato'); }, (err) => { if (!/need via/.test(err.message)) throw err; });
    ok('emulate_media: opzioni del debugger rifiutate via page');
  } catch (e) { fail('emulate_media via page con network', e.message); }
  await wsManager.sendCommand(MessageType.TAB_ACTION, { action: 'close', tab_id }).catch(() => {});
}

// Copia locale della pagina di example.com com'era fino a settembre 2026: il
// sito vero ha cambiato markup (niente h1, niente width) e i test che ci
// contavano sono diventati rossi senza che il nostro codice cambiasse.
const EXAMPLE_HTML = '<!doctype html><html><head><title>Example Domain</title><meta charset="utf-8">'
  + '<style>body{background:#eee;width:60vw;margin:15vh auto;font-family:system-ui,sans-serif}h1{font-size:1.5em}</style></head>'
  + '<body><div><h1>Example Domain</h1><p>This domain is for use in documentation examples without needing permission.</p>'
  + '<p><a href="https://www.iana.org/help/example-domains">Learn more</a></p></div></body></html>';
let FIXTURE_URL = 'https://example.com/';
async function startFixture() {
  const motionHtml = readFileSync(new URL('../bench/motion.html', import.meta.url), 'utf8');
  const http = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/motion' ? motionHtml : EXAMPLE_HTML);
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  FIXTURE_URL = `http://127.0.0.1:${http.address().port}/`;
  return http;
}

async function main() {
  console.log('=== Chrome Bridge DevTools Test ===\n');
  const fixture = await startFixture();

  wsManager = new WSManager(PORT);
  await wsManager.start();
  let browser = null;
  if (LAUNCH) browser = await launchBrowser({ port: PORT, headless: HEADLESS });

  try {
    await waitForConnection();

    // Crea un nuovo tab dedicato per i test (evita di sovrascrivere il terminale su ChromeOS)
    console.log('Creating test tab...');
    const tabData = await wsManager.sendCommand(MessageType.CREATE_TAB, { url: FIXTURE_URL, active: true });
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
    await testNetworkFromLoad();
    await testConsoleCursor(testTabId);

    // New 12 tests
    await testWaitForElement(testTabId);
    await testWaitForElementTimeout(testTabId);
    await testWaitForFunction(testTabId);
    await testScrollTo(testTabId);
    await testSetStorage(testTabId);
    await testFillForm(testTabId);
    await testViewportResize(testTabId);
    await testFullPageScreenshot(testTabId);
    await testHighlightElements(testTabId);
    await testAccessibilityAudit(testTabId);
    await testCollectLinks(testTabId);
    await testMeasureSpacing(testTabId);
    await testWatchDom(testTabId);
    await testEmulateMedia(testTabId);
    await testHover(testTabId);
    await testPressKey(testTabId);

    // 1.16.0
    await testReadForm(testTabId);
    await testKeyboardWalk(testTabId);
    await testListAssetsAndTiming(testTabId);
    await testDiffFromFile(testTabId);
    await testWatch(testTabId);
    await testObserve(testTabId);
    await testHandoffTimeout(testTabId);

    // Unreleased
    await testPageFingerprintClickEffect(testTabId);
    await testTypeTextReadback(testTabId);
    await testHandoffAskViaBanner(testTabId);
    await testHandoffMultiPick(testTabId);

    // 1.19.0 (osservazioni dal campo, docs/osservazioni-campo-2026-09.md)
    await testFindTextSplitLabel(testTabId);
    await testScrollUntilInnerContainer(testTabId);
    await testWaitForTextHiddenWindow();

    // 1.20.0
    await testGetInteractivesLabels(testTabId);

    // 1.21.0
    await testGetCssStyles(testTabId);

    // 1.23.4
    await testElementCommandsNoMatch(testTabId);
    await testToolsNoMatch(testTabId);

    // 1.26.0
    await testTrustedInput(testTabId);
    await testNavigateConnectionRefused(testTabId);

    // 1.27.0
    await testMotion();

    console.log(`\n=== Results: ${passed}/${passed + failed} passed ===`);
    if (failed > 0) {
      console.log('\nFailed tests:');
      for (const r of results.filter((x) => x.status === 'FAIL')) {
        console.log(`  - ${r.name}: ${r.error}`);
      }
    }
  } finally {
    try { if (browser) await browser.stop(); } catch {}
    await wsManager.stop();
    fixture.close();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
