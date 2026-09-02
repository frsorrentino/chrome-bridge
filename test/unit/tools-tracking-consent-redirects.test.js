/**
 * Tre lavori del ciclo di vita che prima si facevano a mano leggendo il log
 * grezzo, e la baseline da file per il confronto col mockup:
 * - track_events: "il pixel spara purchase?" — i beacon decodificati per vendor
 * - cookie_audit: "cosa parte prima del consenso?" — due fotografie confrontate
 * - redirects --csv: "i vecchi URL portano ai nuovi?" — un esito per riga
 * - screenshot_diff from_file: il mockup diventa la baseline
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeTrackingRequests, trackingLines } from '../../server/trackers.js';
import { summarizeConsent, consentLines, siteOf } from '../../server/consent.js';
import { parseRedirectCsv, checkRedirects, redirectLines } from '../../server/redirects.js';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

function build(reply) {
  const handlers = new Map();
  const sent = [];
  registerTools(
    { tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s }) },
    { isConnected: () => true, mode: 'primary', host: '127.0.0.1', port: 8765, sendCommand: async (type, params) => { sent.push({ type, params }); return reply(type, params); } },
    'all',
  );
  return { handlers, sent };
}

// --- trackers ---

test('decodeTrackingRequests riconosce GA4, Meta, Google Ads e ignora il resto', () => {
  const { events } = decodeTrackingRequests([
    { url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC&en=purchase&ep.currency=EUR&epn.value=49.9', startTime: 1000 },
    { url: 'https://www.facebook.com/tr?id=123&ev=Purchase&cd[value]=49.9&cd[currency]=EUR', startTime: 1200 },
    { url: 'https://www.googleadservices.com/pagead/conversion/987/?label=AbC&value=49.9&currency_code=EUR', startTime: 900 },
    { url: 'https://example.com/api/cart', startTime: 950 },
    { url: 'https://analytics.tiktok.com/api/v2/pixel', method: 'POST', startTime: 1300 },
  ]);
  assert.deepEqual(events.map((e) => e.vendor), ['Google Ads', 'GA4', 'Meta Pixel', 'TikTok']);
  assert.equal(events[1].event, 'purchase');
  assert.equal(events[1].params['ep.currency'], 'EUR');
  assert.equal(events[2].params['cd[value]'], '49.9');
  assert.equal(events[3].event, '(body)', 'un POST senza corpo leggibile va dichiarato, non inventato');
  const text = trackingLines({ events, first_ts: 900 });
  assert.match(text, /^tracking events=4 vendors=Google Ads,GA4,Meta Pixel,TikTok/);
  assert.match(text, /\+100ms\tGA4\tpurchase/);
  assert.match(text, /not decoded/);
});

test('trackingLines senza beacon spiega il probabile motivo', () => {
  assert.match(trackingLines(decodeTrackingRequests([])), /source=browser/);
});

// --- consent ---

test('siteOf riduce al dominio registrabile, anche con co.uk', () => {
  assert.equal(siteOf('www.example.com'), 'example.com');
  assert.equal(siteOf('.shop.example.co.uk'), 'example.co.uk');
  assert.equal(siteOf('localhost'), 'localhost');
});

test('summarizeConsent nomina i tracker contattati prima del consenso', () => {
  const s = summarizeConsent({
    pageUrl: 'https://www.example.com/',
    cookiesBefore: [{ name: '_ga', domain: '.example.com' }, { name: 'fr', domain: '.facebook.com' }],
    requestsBefore: [
      { url: 'https://www.example.com/style.css' },
      { url: 'https://www.google-analytics.com/g/collect?en=page_view' },
      { url: 'https://connect.facebook.net/en_US/fbevents.js' },
      { url: 'https://fonts.gstatic.com/x.woff2' },
    ],
    cookiesAfter: [{ name: '_ga', domain: '.example.com' }, { name: 'fr', domain: '.facebook.com' }, { name: '_fbp', domain: '.example.com' }],
    requestsAfter: [{ url: 'https://www.facebook.com/tr?ev=PageView' }],
    consent: 'dismiss_overlays',
  });
  assert.equal(s.site, 'example.com');
  assert.equal(s.before.third_party.length, 3);
  assert.deepEqual(s.after.new_cookies.map((c) => c.name), ['_fbp']);
  assert.deepEqual(s.after.new_third_party.map((t) => t.host), ['www.facebook.com']);
  assert.match(s.findings[0], /2 tracking host\(s\) contacted before consent: www.google-analytics.com, connect.facebook.net/);
  assert.match(s.findings[1], /third-party cookie\(s\) set before consent: fr/);
  const text = consentLines(s);
  assert.match(text, /fonts\.gstatic\.com\t1 req\tfonts/);
  assert.match(text, /after consent: new cookies=1/);
});

test('summarizeConsent senza consenso dichiara che il dopo è vuoto per costruzione', () => {
  const s = summarizeConsent({ pageUrl: 'https://a.it/', requestsBefore: [{ url: 'https://a.it/x' }] });
  assert.match(s.findings.join(' '), /no consent action performed/);
});

// --- redirects ---

test('parseRedirectCsv accetta virgola o punto e virgola, intestazione e commenti', () => {
  const rows = parseRedirectCsv('old,new\n# migrazione\nhttps://a.it/vecchia, https://a.it/nuova\n"https://a.it/x";https://a.it/y\nhttps://a.it/solo\n');
  assert.deepEqual(rows, [
    { from: 'https://a.it/vecchia', expected: 'https://a.it/nuova' },
    { from: 'https://a.it/x', expected: 'https://a.it/y' },
    { from: 'https://a.it/solo', expected: null },
  ]);
});

test('checkRedirects confronta l\'URL finale normalizzato e segna mismatch ed errori', async () => {
  const send = async (_t, { url }) => {
    if (url.endsWith('/boom')) throw new Error('net::ERR');
    if (url.endsWith('/vecchia')) return { status: 200, url: 'https://a.it/nuova/' };
    if (url.endsWith('/x')) return { status: 200, url: 'https://a.it/altrove' };
    return { status: 404, url };
  };
  const results = await checkRedirects(send, [
    { from: 'https://a.it/vecchia', expected: 'http://a.it/nuova' },
    { from: 'https://a.it/x', expected: 'https://a.it/y' },
    { from: 'https://a.it/boom', expected: null },
    { from: 'https://a.it/manca', expected: null },
  ]);
  assert.deepEqual(results.map((r) => r.verdict), ['ok', 'mismatch', 'error', 'error']);
  const text = redirectLines(results);
  assert.match(text, /^redirects total=4 ok=1 mismatch=1 error=2/);
  assert.match(text, /mismatch\t200\thttps:\/\/a\.it\/x\thttps:\/\/a\.it\/altrove\texpected https:\/\/a\.it\/y/);
});

// --- wiring ---

test('screenshot_diff action=baseline from_file manda i byte del PNG all\'estensione', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-diff-'));
  const png = join(dir, 'mock.png');
  await writeFile(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  const { handlers, sent } = build(async () => ({ baseline: 'home', width: 1, height: 1 }));
  await handlers.get('screenshot_diff').handler({ action: 'baseline', name: 'home', from_file: png, threshold: 10 });
  const msg = sent.find((m) => m.type === MessageType.SCREENSHOT_DIFF);
  assert.equal(msg.params.image_b64, Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'));
  await handlers.get('screenshot_diff').handler({ action: 'compare', name: 'home', from_file: png, threshold: 10 });
  assert.equal(sent[1].params.image_b64, undefined, 'from_file vale solo per baseline');
});

test('track_events azzera, aspetta, legge il log browser e decodifica', async () => {
  const { handlers, sent } = build(async (type, p) => (p.clear ? {} : { requests: [{ url: 'https://www.facebook.com/tr?ev=Lead&id=1', startTime: 5 }] }));
  const res = await handlers.get('track_events').handler({ clear: true, wait_ms: 1 });
  assert.equal(sent[0].params.clear, true);
  assert.equal(sent[0].params.source, 'browser');
  assert.match(res.content[0].text, /Meta Pixel\tLead/);
});

test('cookie_audit: cancella i cookie, ricarica, fotografa prima e dopo il consenso', async () => {
  const state = { cookies: [{ name: 'sess', domain: 'shop.it' }], calls: 0 };
  const { handlers, sent } = build(async (type, p) => {
    if (type === MessageType.GET_PAGE_INFO) return { url: 'https://shop.it/' };
    if (type === MessageType.SET_STORAGE) { state.cookies = []; return { cleared: 1 }; }
    if (type === MessageType.GET_STORAGE) return { cookies: state.cookies };
    if (type === MessageType.MONITOR_NETWORK) return p.clear ? {} : { requests: [{ url: 'https://www.google-analytics.com/g/collect?en=page_view' }] };
    if (type === MessageType.CLICK) { state.cookies = [{ name: '_ga', domain: '.shop.it' }]; return { clicked: true }; }
    return {};
  });
  const res = await handlers.get('cookie_audit').handler({ accept_selector: '#accept', settle_ms: 1 });
  const types = sent.map((m) => m.type);
  assert.deepEqual(types.slice(0, 4), [MessageType.GET_PAGE_INFO, MessageType.SET_STORAGE, MessageType.MONITOR_NETWORK, MessageType.NAVIGATE]);
  assert.ok(types.includes(MessageType.CLICK));
  assert.match(res.content[0].text, /consent=click #accept/);
  assert.match(res.content[0].text, /1 tracking host\(s\) contacted before consent: www.google-analytics.com/);
  assert.match(res.content[0].text, /after consent: new cookies=1/);
});

test('cookie_audit rifiuta le pagine non http', async () => {
  const { handlers } = build(async (type) => (type === MessageType.GET_PAGE_INFO ? { url: 'chrome://extensions' } : {}));
  await assert.rejects(() => handlers.get('cookie_audit').handler({ settle_ms: 1 }), /http\(s\) page/);
});
