/**
 * upload_file a pezzi: sopra 6 MB il file viaggia in upload_chunk, sotto resta
 * il messaggio unico che anche un'estensione 1.27 capisce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadBuffer, CHUNK_BYTES, MAX_UPLOAD_BYTES } from '../../server/upload.js';
import { MessageType } from '../../server/protocol.js';

const base = { selector: '#f', name: 'v.mp4', mime_type: 'video/mp4', tab_id: 3 };

test('file piccolo: un solo upload_file con il contenuto', async () => {
  const sent = [];
  await uploadBuffer(async (t, p) => { sent.push({ t, p }); return { uploaded: 'v.mp4' }; }, { ...base, buf: Buffer.alloc(1000, 1) });
  assert.deepEqual(sent.map((m) => m.t), [MessageType.UPLOAD_FILE]);
  assert.equal(Buffer.from(sent[0].p.content_b64, 'base64').length, 1000);
});

test('file grande: pezzi in ordine che ricompongono il file, poi upload_file con id e dimensione', async () => {
  const buf = Buffer.alloc(CHUNK_BYTES * 2 + 123);
  for (let i = 0; i < buf.length; i += 4096) buf[i] = i % 251;
  const sent = [];
  await uploadBuffer(async (t, p) => { sent.push({ t, p }); return {}; }, { ...base, buf });
  const chunks = sent.filter((m) => m.t === MessageType.UPLOAD_CHUNK);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.p.index), [0, 1, 2]);
  assert.ok(chunks.every((c) => c.p.total === 3 && c.p.upload_id === chunks[0].p.upload_id && c.p.tab_id === 3));
  const joined = Buffer.concat(chunks.map((c) => Buffer.from(c.p.content_b64, 'base64')));
  assert.ok(joined.equals(buf));
  const last = sent.at(-1);
  assert.equal(last.t, MessageType.UPLOAD_FILE);
  assert.deepEqual([last.p.upload_id, last.p.size, last.p.content_b64], [chunks[0].p.upload_id, buf.length, undefined]);
});

test('estensione vecchia: abort dei pezzi e messaggio che dice di aggiornare', async () => {
  const sent = [];
  const send = async (t, p) => { sent.push({ t, p }); if (t === MessageType.UPLOAD_CHUNK && !p.abort) throw new Error('Unknown command type: upload_chunk'); return {}; };
  await assert.rejects(uploadBuffer(send, { ...base, buf: Buffer.alloc(CHUNK_BYTES + 1) }), /need the extension from version 1\.28/);
  assert.equal(sent.at(-1).p.abort, true);
});

test('oltre il tetto: rifiutato prima di mandare qualcosa', async () => {
  const sent = [];
  const fake = { length: MAX_UPLOAD_BYTES + 1 };
  await assert.rejects(uploadBuffer(async (t) => { sent.push(t); }, { ...base, buf: fake }), /max 200 MB/);
  assert.equal(sent.length, 0);
});
