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
    if (!/^https:\/\/example\.com/.test(assets.page)) throw new Error(`Unexpected page ${assets.page}`);
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
    await wsManager.sendCommand(MessageType.CLICK, { selector: '#__cb_fp summary', tab_id: tabId });
    await new Promise((r) => setTimeout(r, 150));
    const after = await wsManager.sendCommand(MessageType.PAGE_FINGERPRINT, { tab_id: tabId });
    if (after.open !== before.open + 1) throw new Error(`open ${before.open} -> ${after.open}`);
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
    winTab = await wsManager.sendCommand(MessageType.CREATE_TAB, { url: 'https://example.com', new_window: true });
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

// --- Main ---

async function main() {
  console.log('=== Chrome Bridge DevTools Test ===\n');

  wsManager = new WSManager(PORT);
  await wsManager.start();
  let browser = null;
  if (LAUNCH) browser = await launchBrowser({ port: PORT, headless: HEADLESS });

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
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
