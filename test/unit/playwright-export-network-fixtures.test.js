/**
 * Due modi di portare fuori dal browser reale quello che ci è successo:
 * - un flusso registrato → test Playwright eseguibile in CI senza bridge
 * - le risposte vere di un'API → fixture riservibile con errori e latenza forzati
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toPlaywrightTest } from '../../server/playwright-export.js';
import { addStub, listStubs, clearStubs } from '../../server/stub-server.js';

test('toPlaywrightTest traduce i comandi registrati e lascia i passi umani come pause', () => {
  const { source, steps, skipped } = toPlaywrightTest([
    { command: 'navigate', params: { url: 'https://shop.it/login' } },
    { command: 'fill_form', params: { fields: [{ selector: '#user', value: '{{user}}' }, { selector: '#pass', value: 'x' }], submit_selector: 'button[type=submit]' } },
    { command: 'handoff', params: { message: 'Enter the 2FA code' } },
    { command: 'wait_for_text', params: { text: 'Dashboard', timeout: 20000 } },
    { command: 'click', params: { selector: 'a.orders' } },
    { command: 'assert', params: { selector: 'table tr', count: 3 } },
    { command: 'assert', params: { url: '/orders' } },
    { command: 'get_interactives', params: {} },
  ], { name: 'login' });
  assert.equal(steps, 8);
  assert.deepEqual(skipped, ['get_interactives']);
  assert.match(source, /^import \{ test, expect \} from '@playwright\/test';/);
  assert.match(source, /storageState/);
  assert.match(source, /Variables from the recording: user/);
  assert.match(source, /test\("login", async \(\{ page \}\) => \{\n  await page\.goto\("https:\/\/shop\.it\/login"\);/);
  assert.match(source, /page\.locator\("#user"\)\.fill\("\{\{user\}\}"\);/);
  assert.match(source, /HUMAN STEP in the recording: Enter the 2FA code\n  await page\.pause\(\);/);
  assert.match(source, /expect\(page\.getByText\("Dashboard"\)\.first\(\)\)\.toBeVisible\(\{ timeout: 20000 \}\)/);
  assert.match(source, /toHaveCount\(3\)/);
  assert.match(source, /toHaveURL\(\/\\\/orders\/\)/);
  assert.match(source, /\/\/ get_interactives has no Playwright equivalent/);
});

test('addStub accetta la latenza e la elenca', () => {
  clearStubs();
  const id = addStub({ body: '{}', status: 503, delay_ms: 2000 });
  assert.match(id, /^s\d+$/);
  assert.deepEqual(listStubs()[0], { id, status: 503, content_type: 'application/json', bytes: 2 });
  clearStubs();
});

test('session_record export scrive lo .spec.ts accanto alla registrazione', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-rec-'));
  process.env.CHROME_BRIDGE_RECORD_DIR = dir;
  const { registerTools } = await import('../../server/tools.js?' + Date.now());
  const rec = join(dir, 'flow.jsonl');
  await writeFile(rec, JSON.stringify({ command: 'navigate', params: { url: 'https://a.it' } }) + '\n');
  const handlers = new Map();
  registerTools({ tool: (n, _d, s, ...rest) => handlers.set(n, rest[rest.length - 1]) }, { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async () => ({}) }, 'all');
  const res = await handlers.get('session_record')({ action: 'export', name: rec });
  assert.match(res.content[0].text, /exported 1 step\(s\) to .*flow\.spec\.ts/);
  assert.match(await readFile(join(dir, 'flow.spec.ts'), 'utf8'), /page\.goto\("https:\/\/a\.it"\)/);
});

test('network_rules record rifà le richieste della pagina con i cookie e salva la fixture; replay le riserve con override', async () => {
  const fdir = await mkdtemp(join(tmpdir(), 'cb-fx-'));
  process.env.CHROME_BRIDGE_FIXTURES_DIR = fdir;
  const { registerTools } = await import('../../server/tools.js?fx' + Date.now());
  const { MessageType } = await import('../../server/protocol.js');
  const sent = [];
  const handlers = new Map();
  registerTools({ tool: (n, _d, s, ...rest) => handlers.set(n, rest[rest.length - 1]) }, { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t, p) => {
    sent.push({ t, p });
    if (t === MessageType.MONITOR_NETWORK) return { requests: [{ url: 'https://shop.it/api/items?page=1', method: 'GET' }, { url: 'https://shop.it/api/cart', method: 'POST' }, { url: 'https://cdn.x/y.js', method: 'GET' }] };
    if (t === MessageType.HTTP_REQUEST) return { status: 200, content_type: 'application/json', body: '[{"id":1}]' };
    return { ok: true };
  } }, 'all');
  const rec = await handlers.get('network_rules')({ action: 'record', name: 'catalog', url_filter: '||shop.it/api/*' });
  assert.match(rec.content[0].text, /recorded 1 response\(s\)/);
  const fx = JSON.parse(await readFile(join(fdir, 'catalog.json'), 'utf8'));
  assert.equal(fx.entries[0].url, 'https://shop.it/api/items?page=1');
  const rep = await handlers.get('network_rules')({ action: 'replay', name: 'catalog', overrides: [{ url_contains: '/api/items', status: 500, latency_ms: 1500 }] });
  const rule = sent.find((m) => m.t === MessageType.NETWORK_RULES && m.p.action === 'redirect');
  assert.equal(rule.p.url_filter, '|https://shop.it/api/items^');
  assert.match(rule.p.redirect_url, /\/__stub__\/s\d+$/);
  assert.match(rep.content[0].text, /replaying 1 response\(s\).*\noverride 500 \+1500ms\thttps:\/\/shop\.it\/api\/items\?page=1/);
  clearStubs();
});
