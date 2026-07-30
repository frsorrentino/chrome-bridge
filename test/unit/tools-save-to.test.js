/**
 * Il payload va su disco e nel contesto resta il percorso: quel che il modello
 * non legge non lo paga. Vale sulle pagine grandi, dove il contenuto serve
 * raramente per intero.
 *
 * Qui è opt-in per chiamata invece che automatico: scrivere quattro file a ogni
 * click è una tassa su chi non li leggerà mai, e chrome-bridge non controlla la
 * session dir del client.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../../server/tools.js';

function build(reply) {
  const handlers = new Map();
  registerTools(
    { tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s }) },
    {
      isConnected: () => true, mode: 'primary', host: '127.0.0.1', port: 8765,
      sendCommand: async (type, params) => (typeof reply === 'function' ? reply(type, params) : reply),
    },
    'all',
  );
  return handlers;
}

const out = (n) => join(tmpdir(), `chrome-bridge-saveto-${process.pid}-${n}`);

test('read_page con save_to scrive il contenuto e non lo restituisce', async () => {
  const page = '# Titolo\n\n' + 'contenuto '.repeat(2000);
  const handlers = build(page);
  const path = out('page.md');
  try {
    const res = await handlers.get('read_page').handler({ mode: 'markdown', save_to: path });
    const text = res.content.map((c) => c.text).join('\n');

    assert.equal((await readFile(path, 'utf8')), page);
    assert.match(text, /page\.md/, 'la risposta non dice dove ha scritto');
    assert.ok(text.length < 500, `la risposta è di ${text.length} char: il contenuto è passato lo stesso`);
    assert.match(text, /\d+/, 'la risposta non dichiara la dimensione di quel che ha scritto');
  } finally {
    await rm(path, { force: true });
  }
});

test('read_page senza save_to si comporta esattamente come prima', async () => {
  const handlers = build('contenuto breve');
  const res = await handlers.get('read_page').handler({ mode: 'text' });
  assert.match(res.content.map((c) => c.text).join(''), /contenuto breve/);
});

test('extract accetta save_to', async () => {
  // extract si fa dare l'HTML e lo parsa lato server: lo stub deve restituire
  // una pagina, non già i record.
  const cards = Array.from({ length: 500 }, (_, i) => `<div class="card"><span class="n">${i}</span></div>`).join('');
  const handlers = build(`<html><body>${cards}</body></html>`);
  const path = out('items.json');
  try {
    const res = await handlers.get('extract').handler({
      item_selector: '.card', fields: { n: { selector: '.n' } }, max_items: 500, save_to: path,
    });
    const text = res.content.map((c) => c.text).join('\n');
    assert.match(text, /items\.json/);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).items.length, 500);
    assert.ok(text.length < 500, 'i 500 item sono finiti nel contesto invece che nel file');
  } finally {
    await rm(path, { force: true });
  }
});

test('screenshot con save_to scrive il PNG e non manda l\'immagine al modello', async () => {
  const png = Buffer.from('fake-png-bytes');
  const handlers = build({ data: png.toString('base64'), mimeType: 'image/png' });
  const path = out('shot.png');
  try {
    const res = await handlers.get('screenshot').handler({ save_to: path });
    assert.equal((await readFile(path)).toString(), 'fake-png-bytes');
    assert.ok(!res.content.some((c) => c.type === 'image'), 'l\'immagine è stata inviata comunque');
    assert.match(res.content.map((c) => c.text || '').join(' '), /shot\.png/);
  } finally {
    await rm(path, { force: true });
  }
});
