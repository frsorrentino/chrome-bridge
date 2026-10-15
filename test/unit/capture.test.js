/**
 * capture_downloads (14/10/2026): i file costruiti dalla pagina arrivano su
 * disco senza la finestra «Salva con nome». Il nome lo sceglie la pagina, quindi
 * è input ostile: questi test fissano la pulizia, il divieto di sovrascrivere e
 * il trasferimento a pezzi.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeFileName, openUnique, collectCaptured } from '../../server/capture.js';
import { dispositionName, downloadName } from '../../extension/lib/capture-names.js';
import { registerTools, TOOL_ANNOTATIONS } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

test('il nome della pagina perde percorso, punti iniziali e caratteri riservati', () => {
  assert.equal(sanitizeFileName('../../.ssh/authorized_keys'), 'authorized_keys');
  assert.equal(sanitizeFileName('..\\..\\evil.bat'), 'evil.bat');
  assert.equal(sanitizeFileName('.bashrc'), 'bashrc');
  assert.equal(sanitizeFileName('a<b>c:"d"|e?f*.csv'), 'a_b_c__d__e_f_.csv');
  assert.equal(sanitizeFileName('report\x00\n.pdf'), 'report__.pdf');
  assert.equal(sanitizeFileName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFileName('fattura 2026.pdf. '), 'fattura 2026.pdf');
});

test('senza nome ne inventa uno con l\'estensione del tipo', () => {
  assert.equal(sanitizeFileName('', 'text/csv; charset=utf-8'), 'download.csv');
  assert.equal(sanitizeFileName('...', 'application/pdf'), 'download.pdf');
  assert.equal(sanitizeFileName(null), 'download');
});

test('un nome lunghissimo resta sotto 180 byte e tiene l\'estensione', () => {
  const n = sanitizeFileName(`${'è'.repeat(300)}.xlsx`);
  assert.ok(Buffer.byteLength(n) <= 180, `${Buffer.byteLength(n)} byte`);
  assert.ok(n.endsWith('.xlsx'));
});

test('un file esistente non viene mai sovrascritto', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-cap-'));
  try {
    await writeFile(join(dir, 'a.csv'), 'old');
    const { path, fh } = await openUnique(dir, 'a.csv');
    await fh.close();
    assert.equal(path, join(dir, 'a (1).csv'));
    assert.equal(await readFile(join(dir, 'a.csv'), 'utf8'), 'old');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Content-Disposition: filename* vince su filename', () => {
  assert.equal(dispositionName('attachment; filename="x.pdf"; filename*=UTF-8\'\'fattura%20%C3%A8.pdf'), 'fattura è.pdf');
  assert.equal(dispositionName('attachment; filename="a \\"b\\".csv"'), 'a "b".csv');
  assert.equal(dispositionName('attachment; filename=plain.txt'), 'plain.txt');
  assert.equal(downloadName({ disposition: '', chromeName: '', url: 'https://x.test/exports/report%202026.csv?t=1' }), 'report 2026.csv');
});

// 15/10/2026, prova dal vivo: un download avviato da a[download] su un URL
// http arrivava come download.html, perché a onCreated Chrome non ha ancora
// scelto il nome. Il nome della pagina viene dopo Content-Disposition, come
// in Chrome, e prima dell'URL.
test('il nome di a[download] vince sull\'URL ma non su Content-Disposition', () => {
  assert.equal(downloadName({ disposition: '', chromeName: '', pageName: 'live-page.html', url: 'https://example.com/' }), 'live-page.html');
  assert.equal(downloadName({ disposition: '', chromeName: '', pageName: 'a.csv', url: 'https://x.test/exports/b.csv' }), 'a.csv');
  assert.equal(downloadName({ disposition: 'attachment; filename="srv.bin"', chromeName: '', pageName: 'a.csv', url: 'https://x.test/' }), 'srv.bin');
});

// Pagina finta: due file pronti, uno troppo grande, letti a pezzi da 3 byte.
function fakePage(files) {
  const calls = [];
  const items = files.map((f, i) => ({ id: `c${i}`, frame_id: 0, ...f }));
  const send = async (type, p) => {
    assert.equal(type, MessageType.CAPTURE_FILES);
    calls.push(p);
    if (p.op === 'list') return { armed: true, tabId: 7, items: items.map(({ data, ...m }) => m) };
    if (p.op === 'read') {
      const it = items.find((x) => x.id === p.id);
      return { b64: Buffer.from(it.data).subarray(p.offset, p.offset + p.length).toString('base64') };
    }
    if (p.op === 'drop') { items.splice(items.findIndex((x) => x.id === p.id), 1); return { dropped: p.id }; }
    throw new Error(`op ${p.op}`);
  };
  return { send, calls, items };
}

test('wait scrive i file a pezzi, salta quelli con errore e li toglie dalla pagina', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-cap-'));
  try {
    const page = fakePage([
      { name: '../export.csv', mime: 'text/csv', size: 11, source: 'blob', data: 'a,b\n1,2\n3,4' },
      { name: 'big.zip', source: 'download', error: 'too large: 999 bytes' },
    ]);
    const r = await collectCaptured(page.send, { tab_id: 7, dir, timeout: 1000, settle: 0, poll: 10, chunk: 3 });
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].path, join(dir, 'export.csv'));
    assert.equal(r.saved[0].bytes, 11);
    assert.equal(await readFile(join(dir, 'export.csv'), 'utf8'), 'a,b\n1,2\n3,4');
    assert.equal(page.calls.filter((c) => c.op === 'read').length, 4, 'pezzi da 3 byte: 4 letture');
    assert.deepEqual(r.skipped.map((s) => s.name), ['big.zip']);
    assert.equal(page.items.length, 0, 'tutto tolto dalla pagina');
    assert.deepEqual(await readdir(dir), ['export.csv']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('wait senza file scade e lo dice', async () => {
  const page = fakePage([]);
  const r = await collectCaptured(page.send, { tab_id: 7, dir: tmpdir(), timeout: 50, poll: 10 });
  assert.deepEqual(r.saved, []);
  assert.ok(r.waited_ms >= 50);
});

function build(reply) {
  const handlers = new Map();
  const sent = [];
  registerTools(
    { tool: (n, _d, _s, ...rest) => handlers.set(n, rest[rest.length - 1]) },
    { isConnected: () => true, mode: 'primary', host: '1', port: 1, sendCommand: async (type, params) => { sent.push({ type, params }); return reply(type, params); } },
    'core',
  );
  return { handlers, sent };
}

test('capture_downloads è nel core e ha le sue annotations', () => {
  const { handlers } = build(() => ({}));
  assert.ok(handlers.has('capture_downloads'));
  assert.equal(TOOL_ANNOTATIONS.capture_downloads.readOnlyHint, false);
});

test('arm rifiuta cartelle relative e cartelle di chiavi', async () => {
  const { handlers, sent } = build(() => ({ tabId: 3 }));
  const arm = handlers.get('capture_downloads');
  await assert.rejects(arm({ action: 'arm', save_dir: 'relativa' }), /absolute/);
  await assert.rejects(arm({ action: 'arm', save_dir: join(homedir(), '.ssh', 'x') }), /credential/);
  assert.equal(sent.length, 0, 'niente arriva all\'estensione');
});

test('arm crea la cartella, limita max_mb e wait senza arm è un errore chiaro', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'cb-cap-')), 'nuova');
  try {
    const { handlers, sent } = build((type, p) => (p.op === 'arm' ? { armed: true, tabId: 9, max_bytes: p.max_bytes } : { armed: true, tabId: 9, items: [] }));
    const tool = handlers.get('capture_downloads');
    await assert.rejects(tool({ action: 'wait', tab_id: 5, timeout: 10 }), /arm/);
    const r = JSON.parse((await tool({ action: 'arm', save_dir: dir, max_mb: 5000 })).content[0].text);
    assert.equal(r.max_mb, 200);
    assert.equal(sent[0].params.max_bytes, 200 * 1024 * 1024);
    assert.deepEqual(await readdir(dir), []);
    const w = JSON.parse((await tool({ action: 'wait', timeout: 30 })).content[0].text);
    assert.match(w.hint, /Nothing captured/);
  } finally { await rm(join(dir, '..'), { recursive: true, force: true }); }
});

test('manage_downloads fermo sul selettore suggerisce http_request save_to', async () => {
  const handlers = new Map();
  registerTools(
    { tool: (n, _d, _s, ...rest) => handlers.set(n, rest[rest.length - 1]) },
    { isConnected: () => true, mode: 'primary', host: '1', port: 1, sendCommand: async () => ({ id: 1, url: 'https://x.test/f.pdf', state: 'waiting_for_user', done: false }) },
    'all',
  );
  const r = JSON.parse((await handlers.get('manage_downloads')({ action: 'download', url: 'https://x.test/f.pdf' })).content[0].text);
  assert.match(r.hint, /http_request/);
  assert.match(r.hint, /save_to/);
});
