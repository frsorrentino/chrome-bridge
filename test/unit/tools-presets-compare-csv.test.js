/**
 * Tre piccole capacità dal ciclo di vita:
 * - screenshot presets: tre viewport in una chiamata, finestra ripristinata
 * - screenshot_diff compare_urls: produzione contro staging, pixel + testo
 * - fill_form --from CSV: modulo lungo da dati strutturati, a zero token
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';
import { parseCsv, rowToFields, fillFromRows, fillLines } from '../../server/csv-fill.js';

const PNG = 'iVBORw0KGgo=';
function build(reply) {
  const handlers = new Map(); const sent = [];
  registerTools({ tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s }) },
    { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t, p) => { sent.push({ type: t, params: p }); return reply(t, p, sent); } }, 'all');
  return { handlers, sent };
}

test('screenshot presets: un resize e una cattura per preset, poi la finestra torna com\'era', async () => {
  let width = 1600;
  const { handlers, sent } = build(async (t, p) => {
    if (t === MessageType.VIEWPORT_RESIZE) {
      if (p.read_only) return { window: { width: 1600, height: 900, left: 0, top: 0 } };
      width = p.preset === 'mobile' ? 375 : 1425;
      return { actual: {} };
    }
    if (t === MessageType.SCREENSHOT) return { image: PNG, viewport: { width, height: 700 } };
    return {};
  });
  const dir = await mkdtemp(join(tmpdir(), 'cb-shots-'));
  const res = await handlers.get('screenshot').handler({ presets: ['mobile', 'desktop'], save_to: dir });
  const resizes = sent.filter((m) => m.type === MessageType.VIEWPORT_RESIZE).map((m) => m.params);
  assert.equal(resizes[0].read_only, true);
  assert.deepEqual(resizes.slice(1, 3).map((r) => r.preset), ['mobile', 'desktop']);
  assert.deepEqual({ width: resizes[3].width, height: resizes[3].height }, { width: 1600, height: 900 }, 'ripristino');
  assert.deepEqual((await readdir(dir)).sort(), ['desktop.png', 'mobile.png']);
  assert.match(res.content[0].text, /mobile: .*mobile\.png \(viewport 375×700\)/);
});

test('screenshot presets: una larghezza rifiutata dal window manager non esce etichettata come mobile', async () => {
  const { handlers } = build(async (t, p) => {
    if (t === MessageType.VIEWPORT_RESIZE) return p.read_only ? { window: { width: 1600, height: 900 } } : { actual: {}, zoom: 0.67 };
    if (t === MessageType.SCREENSHOT) return { image: PNG, viewport: { width: 2226, height: 1083 } };
    return {};
  });
  const res = await handlers.get('screenshot').handler({ presets: ['mobile'] });
  assert.deepEqual(res.content.map((c) => c.type), ['text'], 'nessuna immagine');
  assert.match(res.content[0].text, /mobile: NOT APPLIED — viewport stayed 2226×1083 CSS px \(asked ~375, page zoom 67%\)/);
});

test('screenshot presets senza save_to restituisce le immagini con la riga del viewport', async () => {
  const { handlers } = build(async (t) => (t === MessageType.SCREENSHOT ? { image: PNG, viewport: { width: 768, height: 1024 } } : { window: {} }));
  const res = await handlers.get('screenshot').handler({ presets: ['tablet'] });
  assert.deepEqual(res.content.map((c) => c.type), ['text', 'image']);
  assert.match(res.content[0].text, /tablet: viewport 768×1024/);
});

test('compare_urls naviga A, baseline, naviga B, compare, e allega il diff testuale', async () => {
  let page = '';
  const { handlers, sent } = build(async (t, p) => {
    if (t === MessageType.NAVIGATE) { page = p.url; return {}; }
    if (t === MessageType.READ_PAGE) return page.includes('staging') ? 'Home\nPrezzo 12€\nNuovo banner' : 'Home\nPrezzo 10€';
    if (t === MessageType.SCREENSHOT_DIFF) return p.action === 'compare' ? { match: false, diff_percent: 3.5, diff_image: PNG } : {};
    return {};
  });
  const res = await handlers.get('screenshot_diff').handler({ action: 'compare_urls', url_a: 'https://prod.it/', url_b: 'https://staging.it/', mask: ['.date'], name: 'default', threshold: 10 });
  const seq = sent.map((m) => m.type);
  assert.deepEqual(seq.filter((t) => t === MessageType.NAVIGATE).length, 2);
  assert.equal(sent.find((m) => m.type === MessageType.INJECT_CSS).params.css, '.date { visibility: hidden !important; }');
  const text = res.content[0].text;
  assert.match(text, /pixels: 3\.5% changed/);
  assert.match(text, /text: 1 line\(s\) only in A, 2 only in B\n- Prezzo 10€\n\+ Prezzo 12€\n\+ Nuovo banner/);
  assert.equal(res.content[1].type, 'image');
  assert.ok(sent.some((m) => m.type === MessageType.SCREENSHOT_DIFF && m.params.action === 'clear'), 'la baseline temporanea va rimossa');
});

test('compare_urls senza i due URL rifiuta', async () => {
  const { handlers } = build(async () => ({}));
  await assert.rejects(() => handlers.get('screenshot_diff').handler({ action: 'compare_urls', url_a: 'https://a.it' }), /url_a and url_b/);
});

test('parseCsv gestisce virgolette, punto e virgola e righe vuote', () => {
  const rows = parseCsv('name;email;note\n"Rossi, Mario";m@x.it;"dice ""ciao"""\n\nAnna;a@x.it;\n');
  assert.deepEqual(rows, [{ name: 'Rossi, Mario', email: 'm@x.it', note: 'dice "ciao"' }, { name: 'Anna', email: 'a@x.it', note: '' }]);
});

test('rowToFields mappa selettore → colonna e rifiuta colonne assenti', () => {
  assert.deepEqual(rowToFields({ name: 'A', email: 'a@x' }, { '#n': 'name', '#e': 'email' }), [{ selector: '#n', value: 'A' }, { selector: '#e', value: 'a@x' }]);
  assert.throws(() => rowToFields({ name: 'A' }, { '#p': 'phone' }), /Column "phone" not in CSV/);
});

test('fillFromRows compila una riga per volta, con navigate, submit e verifica', async () => {
  const sent = [];
  const send = async (t, p) => { sent.push({ t, p }); if (t === 'find_text') return { matches: p.text === 'Saved' && sent.filter((x) => x.t === 'fill_form').length === 1 ? [{}] : [] }; return {}; };
  const results = await fillFromRows(send, { rows: [{ name: 'A' }, { name: 'B' }], map: { '#n': 'name' }, url: 'https://crm.it/new', submit: '#save', assert_text: 'Saved' });
  assert.deepEqual(results.map((r) => r.verdict), ['ok', 'no "Saved" on the page']);
  assert.equal(sent.filter((x) => x.t === 'navigate').length, 2);
  assert.equal(sent.find((x) => x.t === 'fill_form').p.submit_selector, '#save');
  assert.match(fillLines(results), /^fill_form rows=2 ok=1 failed=1\n1\tok\n2\tno "Saved" on the page/);
});
