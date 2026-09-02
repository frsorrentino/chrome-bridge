/**
 * Quattro capacità della sezione E dell'analisi 2026-09-01:
 * - keyboard_walk: "si naviga da tastiera?" — ordine di tab e anomalie
 * - slow_plugins: "quale plugin rallenta?" — Resource Timing per origine
 * - cache_check: "la CDN serve la versione nuova?" — validatori a confronto
 * - find_setting: "dove si imposta X nel pannello?" — i link del menu, uno a uno
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupResources, resourceLines, groupKey } from '../../server/resources.js';
import { cacheVerdict, cacheLines } from '../../server/cache-check.js';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

function build(reply) {
  const handlers = new Map();
  const sent = [];
  registerTools(
    { tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s }) },
    { isConnected: () => true, mode: 'primary', host: '127.0.0.1', port: 8765, sendCommand: async (type, params) => { sent.push({ type, params }); return reply(type, params, sent); } },
    'all',
  );
  return { handlers, sent };
}

// --- resources ---

test('groupKey attribuisce plugin, tema, modulo, sito e host esterni', () => {
  assert.equal(groupKey('https://shop.it/wp-content/plugins/woocommerce/a.js', 'shop.it'), 'plugin:woocommerce');
  assert.equal(groupKey('https://shop.it/wp-content/themes/astra/style.css', 'shop.it'), 'theme:astra');
  assert.equal(groupKey('https://shop.it/modules/ps_facetedsearch/x.js', 'shop.it'), 'module:ps_facetedsearch');
  assert.equal(groupKey('https://shop.it/img/logo.png', 'shop.it'), 'site');
  assert.equal(groupKey('https://fonts.gstatic.com/a.woff2', 'shop.it'), 'fonts.gstatic.com');
});

test('groupResources ordina per tempo e conta i render-blocking', () => {
  const r = groupResources([
    { name: 'https://shop.it/wp-content/plugins/slider/big.js', duration: 800, transfer: 400000, blocking: 'blocking' },
    { name: 'https://shop.it/wp-content/plugins/slider/x.css', duration: 100, transfer: 10000, blocking: 'blocking' },
    { name: 'https://shop.it/wp-content/plugins/seo/y.js', duration: 50, transfer: 2000 },
    { name: 'https://cdn.x.com/z.js', duration: 300, transfer: 90000 },
  ], { pageHost: 'shop.it' });
  assert.deepEqual(r.groups.map((g) => g.group), ['plugin:slider', 'cdn.x.com', 'plugin:seo']);
  assert.equal(r.groups[0].blocking, 2);
  assert.equal(r.groups[0].slowest, 'https://shop.it/wp-content/plugins/slider/big.js');
  const text = resourceLines(r, { dom_content_loaded: 1200, load: 2500 });
  assert.match(text, /^resources requests=4 groups=3 transfer=490KB DCL=1200ms load=2500ms/);
  assert.match(text, /plugin:slider\t2 req\t400KB\t900ms\t2 blocking\tslowest 800ms big\.js/);
});

// --- cache ---

test('cacheVerdict confronta etag, poi last-modified, poi la dimensione', () => {
  assert.equal(cacheVerdict({ status: 200, headers: { etag: '"a"', 'cf-cache-status': 'HIT', age: '120' } }, { status: 200, headers: { etag: '"a"' } }).verdict, 'fresh');
  const stale = cacheVerdict({ status: 200, headers: { etag: '"a"', 'x-cache': 'HIT' } }, { status: 200, headers: { etag: '"b"' } });
  assert.equal(stale.verdict, 'stale');
  assert.equal(stale.cache_status, 'x-cache=HIT');
  assert.equal(cacheVerdict({ status: 200, headers: { 'last-modified': 'Mon' } }, { status: 200, headers: { 'last-modified': 'Tue' } }).verdict, 'stale');
  assert.equal(cacheVerdict({ status: 200, headers: {}, size: 10 }, { status: 200, headers: {}, size: 10 }).verdict, 'probably fresh');
  assert.equal(cacheVerdict({ status: 200, headers: {} }, { status: 200, headers: {} }).verdict, 'unknown');
  assert.equal(cacheVerdict({ status: 200, headers: { etag: '"a"' } }, { status: 404, headers: { etag: '"a"' } }).verdict, 'differs');
  assert.match(cacheLines([{ url: 'https://a.it/x.css', verdict: 'stale', basis: 'etag', cache_status: 'cf-cache-status=HIT', age: 120 }]), /stale_or_different=1\nstale\thttps:\/\/a\.it\/x\.css\tcf-cache-status=HIT\tage 120s\tetag/);
});

// --- wiring ---

test('keyboard_walk stampa una riga per passo e il riepilogo dei problemi', async () => {
  const { handlers } = build(async () => ({
    total_focusable: 3, walked: 2, positive_tabindex: 1, dialog_open: false,
    steps: [{ step: 1, selector: '#a', tag: 'a', text: 'Home', tabindex: 0, issue: null }, { step: 2, selector: 'button.x:nth-of-type(1)', tag: 'button', text: 'Go', tabindex: 3, issue: 'no visible focus indicator' }],
    issues: { 'no visible focus indicator': 1 },
  }));
  const res = await handlers.get('keyboard_walk').handler({ max_steps: 60 });
  const t = res.content[0].text;
  assert.match(t, /^keyboard walk focusable=3 walked=2 positive_tabindex=1\nissues: 1× no visible focus indicator/);
  assert.match(t, /2\tbutton\.x:nth-of-type\(1\)\tbutton\[tabindex=3\]\tGo\tno visible focus indicator/);
});

test('cache_check chiede pagina e asset due volte, con e senza cache-buster', async () => {
  const { handlers, sent } = build(async (type, p) => {
    if (type === MessageType.LIST_ASSETS) return { page: 'https://a.it/', stylesheets: ['https://a.it/s.css'], scripts: [], images: [] };
    if (type === MessageType.HTTP_REQUEST) return { status: 200, headers: { etag: p.url.includes('cb=') && p.url.includes('s.css') ? '"new"' : '"old"' } };
    return {};
  });
  const res = await handlers.get('cache_check').handler({ assets: true, max_assets: 8 });
  const reqs = sent.filter((m) => m.type === MessageType.HTTP_REQUEST).map((m) => m.params.url);
  assert.equal(reqs.length, 4);
  assert.match(reqs[1], /^https:\/\/a\.it\/\?cb=\d+$/);
  assert.match(res.content[0].text, /stale_or_different=1/);
  assert.match(res.content[0].text, /fresh\thttps:\/\/a\.it\//);
  assert.match(res.content[0].text, /stale\thttps:\/\/a\.it\/s\.css/);
});

test('cache_check rifiuta le pagine non http', async () => {
  const { handlers } = build(async () => ({ page: 'chrome://newtab', stylesheets: [], scripts: [], images: [] }));
  await assert.rejects(() => handlers.get('cache_check').handler({ assets: true, max_assets: 1 }), /http\(s\) page/);
});

test('slow_plugins raggruppa le voci di Resource Timing della pagina', async () => {
  const { handlers } = build(async () => ({ host: 'shop.it', entries: [{ name: 'https://shop.it/wp-content/plugins/slider/x.js', duration: 300, transfer: 1024 }], navigation: { load: 900 } }));
  const res = await handlers.get('slow_plugins').handler({ top: 15 });
  assert.match(res.content[0].text, /load=900ms\nplugin:slider\t1 req\t1KB\t300ms/);
});

test('find_setting prova prima i link del menu che contengono la parola e si ferma alla pagina trovata', async () => {
  const pages = {
    'https://p.it/admin': { links: [{ url: 'https://p.it/admin/general', text: 'General' }, { url: 'https://p.it/admin/media', text: 'Media & WebP' }], text: '' },
    'https://p.it/admin/media': { links: [], text: 'Convert uploads to WebP' },
    'https://p.it/admin/general': { links: [], text: 'Site title' },
  };
  let current = 'https://p.it/admin';
  const { handlers, sent } = build(async (type, p) => {
    if (type === MessageType.GET_PAGE_INFO) return { url: current };
    if (type === MessageType.COLLECT_LINKS) return { links: pages[current].links };
    if (type === MessageType.NAVIGATE) { current = p.url; return { url: p.url }; }
    if (type === MessageType.FIND_TEXT) return pages[current].text.toLowerCase().includes(p.text.toLowerCase()) ? { matches: [{ context: pages[current].text }] } : { matches: [] };
    return {};
  });
  const res = await handlers.get('find_setting').handler({ keyword: 'webp', max_pages: 25, menu_selector: 'nav' });
  const navs = sent.filter((m) => m.type === MessageType.NAVIGATE).map((m) => m.params.url);
  assert.deepEqual(navs, ['https://p.it/admin/media'], 'il link "Media & WebP" va provato per primo');
  assert.match(res.content[0].text, /found after 1 page\(s\): https:\/\/p\.it\/admin\/media\nmenu path: Media & WebP/);
});

test('find_setting rispetta max_pages e dice cosa ha provato', async () => {
  const links = Array.from({ length: 10 }, (_, i) => ({ url: `https://p.it/${i}`, text: `Page ${i}` }));
  const { handlers, sent } = build(async (type) => {
    if (type === MessageType.GET_PAGE_INFO) return { url: 'https://p.it/admin' };
    if (type === MessageType.COLLECT_LINKS) return { links };
    if (type === MessageType.FIND_TEXT) return { matches: [] };
    return {};
  });
  const res = await handlers.get('find_setting').handler({ keyword: 'zzz', max_pages: 3, menu_selector: 'nav' });
  assert.equal(sent.filter((m) => m.type === MessageType.NAVIGATE).length, 3);
  assert.match(res.content[0].text, /not found in 3 page\(s\)/);
});
