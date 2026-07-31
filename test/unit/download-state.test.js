/**
 * Il caso che questi test fissano è stato osservato dal vivo, non immaginato:
 * `manage_downloads action=download` rispondeva `{started: true, id: 4261}` e
 * l'operazione era ferma sul selettore di destinazione di ChromeOS. L'API
 * diceva `state: 'in_progress'`, `filename: ''`, `bytesReceived === totalBytes`
 * — tutti i byte presi, nessun posto dove metterli.
 *
 * Dichiarare "started" e fermarsi è la stessa classe di errore del 200 HTTP
 * dell'upload sullo store: un esito plausibile scambiato per un esito.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDownload } from '../../extension/lib/download-state.js';

test('un download fermo sul selettore non è "in corso"', () => {
  const r = classifyDownload({ state: 'in_progress', filename: '', bytesReceived: 1092, totalBytes: 1092 });
  assert.equal(r.state, 'waiting_for_user');
  assert.equal(r.done, false);
  assert.match(r.reason, /where to save|saveAs/i, 'la ragione non nomina il selettore');
});

test('senza destinazione e senza byte è comunque attesa di una persona', () => {
  const r = classifyDownload({ state: 'in_progress', filename: '', bytesReceived: 0, totalBytes: 0 });
  assert.equal(r.state, 'waiting_for_user');
});

test('un download in corso con destinazione è in corso davvero', () => {
  const r = classifyDownload({ state: 'in_progress', filename: '/tmp/x.pdf', bytesReceived: 50, totalBytes: 100 });
  assert.equal(r.state, 'in_progress');
  assert.equal(r.done, false);
  assert.deepEqual(r.bytes, { received: 50, total: 100 });
});

test('complete porta il percorso, ed è finito', () => {
  const r = classifyDownload({ state: 'complete', filename: '/tmp/x.pdf', bytesReceived: 100, totalBytes: 100 });
  assert.equal(r.state, 'complete');
  assert.equal(r.done, true);
  assert.equal(r.filename, '/tmp/x.pdf');
});

test('interrotto è finito e porta il motivo, non un silenzio', () => {
  const r = classifyDownload({ state: 'interrupted', filename: '', error: 'NETWORK_FAILED' });
  assert.equal(r.state, 'interrupted');
  assert.equal(r.done, true);
  assert.equal(r.error, 'NETWORK_FAILED');
});

test('un id che non esiste non viene scambiato per un successo', () => {
  const r = classifyDownload(undefined);
  assert.equal(r.done, false);
  assert.match(r.reason, /not found/i);
});
