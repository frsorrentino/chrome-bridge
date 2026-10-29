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

// Dalle note di claude-observe (ottobre): save_to in una cartella che non c'è
// ancora dava ENOENT (http_request ×8, execute_js ×2), e save_to uguale a una
// cartella dava EISDIR dopo aver già fatto lo screenshot (×4). Un turno perso
// per un mkdir o per un nome di file.
test('save_to crea le cartelle che mancano', async () => {
  const dir = out('nuova');
  const path = join(dir, 'a', 'b', 'res.txt');
  try {
    const handlers = build({ result: 'ciao' });
    const res = await handlers.get('execute_js').handler({ code: '1', save_to: path });
    assert.equal(await readFile(path, 'utf8'), 'ciao');
    assert.match(res.content[0].text, /res\.txt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('http_request con save_to crea le cartelle che mancano', async () => {
  const dir = out('scarico');
  const path = join(dir, 'sotto', 'file.bin');
  try {
    const handlers = build({ status: 200, headers: {}, body_b64: Buffer.from('xyz').toString('base64') });
    await handlers.get('http_request').handler({ url: 'https://example.com/f.bin', save_to: path });
    assert.equal(await readFile(path, 'utf8'), 'xyz');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('save_to che è una cartella: il file va dentro, con un nome generato', async () => {
  const { mkdir, readdir } = await import('node:fs/promises');
  const dir = out('cartella');
  await mkdir(dir, { recursive: true });
  try {
    const handlers = build({ data: Buffer.from('png').toString('base64'), mimeType: 'image/png' });
    const res = await handlers.get('screenshot').handler({ save_to: dir });
    const files = await readdir(dir);
    assert.equal(files.length, 1, `nella cartella: ${files}`);
    assert.match(files[0], /\.png$/);
    assert.equal(await readFile(join(dir, files[0]), 'utf8'), 'png');
    assert.ok(res.content[0].text.includes(files[0]), 'la risposta non dice il nome scelto');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
