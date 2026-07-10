import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// RECORDINGS_DIR è letto a import time: fissa l'env prima dell'import
const RECORD_DIR = await mkdtemp(join(tmpdir(), 'cb-rec-'));
process.env.CHROME_BRIDGE_RECORD_DIR = RECORD_DIR;
const { registerTools } = await import('../../server/tools.js');
const { substituteVars, parseReplayFile } = await import('../../server/cli.js');

function setup(canned = {}) {
  const handlers = new Map();
  const fakeServer = { tool(name, _d, _s, handler) { handlers.set(name, handler); } };
  const fakeWs = {
    isConnected: () => true, mode: 'primary', port: 8765,
    sendCommand: async (type, params) => {
      if (typeof canned[type] === 'function') return canned[type](params);
      if (!(type in canned)) throw new Error(`No canned response for ${type}`);
      return canned[type];
    },
  };
  registerTools(fakeServer, fakeWs);
  return handlers;
}

const textOf = (r) => r.content.find((c) => c.type === 'text')?.text;

const CATALOG_HTML = `<html><body><table><tbody>
  <tr id="row-0"><td class="name">Widget A</td><td class="price">$10</td><td><button data-sku="SKU-A">Details</button></td></tr>
  <tr id="row-1"><td class="name">Widget B</td><td class="price">$20</td><td><button data-sku="SKU-B">Details</button></td></tr>
  <tr id="row-2"><td class="name">Widget   C</td><td class="price">$30</td><td></td></tr>
</tbody></table></body></html>`;

test('extract: campi relativi, attr, whitespace collassato, campo mancante null', async () => {
  const handlers = setup({ read_page: CATALOG_HTML });
  const out = JSON.parse(textOf(await handlers.get('extract')({
    item_selector: 'tbody tr',
    fields: {
      name: { selector: '.name' },
      sku: { selector: 'button', attr: 'data-sku' },
    },
    format: 'json',
  })));
  assert.equal(out.total, 3);
  assert.deepEqual(out.items[0], { name: 'Widget A', sku: 'SKU-A' });
  assert.equal(out.items[2].name, 'Widget C');
  assert.equal(out.items[2].sku, null);
});

test('extract: formato lines con header, max_items rispettato', async () => {
  const handlers = setup({ read_page: CATALOG_HTML });
  const text = textOf(await handlers.get('extract')({
    item_selector: 'tbody tr',
    fields: { name: { selector: '.name' } },
    max_items: 2,
  }));
  const lines = text.split('\n');
  assert.equal(lines[0], 'extract total=3 shown=2');
  assert.equal(lines[1], 'name');
  assert.equal(lines[2], 'Widget A');
  assert.equal(lines.length, 4);
});

test('session_record: start → comandi registrati senza tab_id → stop', async () => {
  const handlers = setup({
    navigate: { url: 'https://x.test', title: 'X', tabId: 5 },
    click: { clicked: true },
    get_tabs: [],
  });
  await handlers.get('session_record')({ action: 'start', name: 'flow-test' });
  await handlers.get('navigate')({ url: 'https://x.test' });
  await handlers.get('click')({ selector: '#go', tab_id: 99 });
  const stopped = JSON.parse(textOf(await handlers.get('session_record')({ action: 'stop' })));
  assert.equal(stopped.stopped, 'flow-test');

  const lines = (await readFile(join(RECORD_DIR, 'flow-test.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const commands = lines.map((l) => l.command);
  assert.deepEqual(commands.filter((c) => c !== 'get_interactives'), ['navigate', 'click']);
  const click = lines.find((l) => l.command === 'click');
  assert.equal(click.params.tab_id, undefined, 'tab_id strippato');
  assert.equal(click.params.selector, '#go');
  // get_tabs (tabSnapshot interno) escluso
  assert.ok(!commands.includes('get_tabs'));
  await rm(RECORD_DIR, { recursive: true, force: true });
});

test('replay helpers: parse jsonl e sostituzione {{var}} ricorsiva', () => {
  const steps = parseReplayFile('{"command":"navigate","params":{"url":"https://{{host}}/login"}}\n\n{"command":"fill_form","params":{"fields":[{"selector":"#u","value":"{{user}}"}]}}\n');
  assert.equal(steps.length, 2);
  const p = substituteVars(steps[1].params, { user: 'jane' });
  assert.equal(p.fields[0].value, 'jane');
  const q = substituteVars(steps[0].params, { host: 'x.test' });
  assert.equal(q.url, 'https://x.test/login');
  // placeholder senza var resta intatto
  assert.equal(substituteVars('{{missing}}', {}), '{{missing}}');
  assert.throws(() => parseReplayFile('not json'), /Invalid JSON at line 1/);
});
