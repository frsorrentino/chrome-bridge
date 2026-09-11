/**
 * bench/latency: una tabella di millisecondi per tool, misurata sul percorso
 * reale (stdio MCP → server → WebSocket → estensione → pagina). Il runner ha
 * bisogno di Chrome; qui si inchioda la parte pura: le statistiche e il
 * Markdown che finisce in docs/PERFORMANCE.md.
 *
 * Il p95 è nearest-rank (il campione di rango ceil(0.95·n)), non
 * un'interpolazione: con 5 giri è il massimo, e lo si dichiara nel documento.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, renderReport } from '../../bench/latency-stats.js';

test('summarize: mediana, p95 nearest-rank, min e max', () => {
  const s = summarize([30, 10, 50, 20, 40]);
  assert.deepEqual(s, { n: 5, min: 10, median: 30, p95: 50, max: 50 });
});

test('summarize: mediana di un numero pari di campioni è la media dei due centrali', () => {
  assert.equal(summarize([10, 20, 30, 40]).median, 25);
});

test('summarize: p95 nearest-rank su 20 campioni prende il 19º', () => {
  const samples = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200
  assert.equal(summarize(samples).p95, 190);
});

test('summarize: nessun campione non esplode', () => {
  assert.deepEqual(summarize([]), { n: 0, min: null, median: null, p95: null, max: null });
});

test('renderReport: una riga per tool, in millisecondi interi, con data e ambiente', () => {
  const md = renderReport({
    date: '2026-09-11',
    env: { node: 'v24.13.1', chrome: '140.0.0.0', extension: '1.16.1', server: '1.16.1', platform: 'linux' },
    rounds: 5,
    cold_start_ms: 1511.4,
    rows: [
      { tool: 'get_tabs', ...summarize([1.2, 2.4, 1.9, 2.1, 1.8]), note: 'transport only' },
      { tool: 'click', ...summarize([6056]), note: 'label, no navigation' },
    ],
  });
  assert.match(md, /^# /m);
  assert.match(md, /2026-09-11/);
  assert.match(md, /Chrome 140\.0\.0\.0/);
  assert.match(md, /extension 1\.16\.1/);
  assert.match(md, /cold start.*1511 ms/i);
  assert.match(md, /\| `get_tabs` \| 1 \| 2 \| 2 \| 2 \| transport only \|/);
  assert.match(md, /\| `click` \| 6056 \| 6056 \| 6056 \| 6056 \| label, no navigation \|/);
  assert.match(md, /nearest-rank/, 'il documento deve dire come è calcolato il p95');
});

test('renderReport: segnala nella riga un tool sopra la soglia dichiarata', () => {
  const md = renderReport({
    date: '2026-09-11', env: {}, rounds: 5, cold_start_ms: 0, threshold_ms: 2000,
    rows: [{ tool: 'scroll', ...summarize([30007, 30002, 30105, 30010, 30000]), note: '' }],
  });
  assert.match(md, /`scroll`.*⚠/, 'un tool con mediana sopra soglia deve essere marcato nella tabella');
  assert.match(md, /2000 ms/);
});
