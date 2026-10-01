/**
 * heap_snapshot e lighthouse: sintesi dei file che i due strumenti scrivono.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHeap, diffHeap } from '../../server/heap.js';
import { lighthouseVersion, lighthouseArgs, summarizeLighthouse } from '../../server/lighthouse.js';

// Istantanea minima nel formato di DevTools: 7 campi per nodo.
function snapshot(nodes) {
  const strings = ['', 'Foo', 'HTMLDivElement', 'x'];
  const flat = nodes.flatMap(([type, name, size, detached = 0]) => [type, name, 1, size, 0, 0, detached]);
  return {
    snapshot: { meta: { node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'], node_types: [['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native']] } },
    nodes: flat, strings,
  };
}

test('heap: oggetti per costruttore, il resto per tipo, nodi DOM staccati', () => {
  const s = summarizeHeap(snapshot([[3, 1, 100], [3, 1, 50], [2, 3, 30], [8, 2, 200, 2]]));
  assert.equal(s.nodes, 4);
  assert.equal(s.total_self_size, 380);
  assert.equal(s.detached_dom_nodes, 1);
  assert.deepEqual(s.top.map((c) => [c.name, c.count, c.self_size]), [['HTMLDivElement', 1, 200], ['Foo', 2, 150], ['(string)', 1, 30]]);
});

test('heap: il confronto mette prima le classi cresciute di più', () => {
  const a = summarizeHeap(snapshot([[3, 1, 100], [2, 3, 30]]));
  const b = summarizeHeap(snapshot([[3, 1, 100], [3, 1, 100], [3, 1, 100], [2, 3, 30], [2, 3, 40]]));
  const d = diffHeap(a, b);
  assert.equal(d.total_size_delta, 240);
  assert.deepEqual(d.grown.map((g) => [g.name, g.count_delta, g.size_delta]), [['Foo', 2, 200], ['(string)', 1, 40]]);
});

test('lighthouse: versione secondo Node, argomenti del CLI', () => {
  assert.equal(lighthouseVersion('20.20.0'), '12.8.2');
  assert.equal(lighthouseVersion('22.19.0'), '13.5.0');
  assert.equal(lighthouseVersion('24.1.0'), '13.5.0');
  const args = lighthouseArgs('https://a.it/', 9333, '/tmp/lh', { categories: ['performance'], formFactor: 'desktop' });
  assert.ok(args.includes('--port=9333') && args.includes('--only-categories=performance') && args.includes('--preset=desktop'));
});

test('lighthouse: punteggi 0-100, metriche, voci non superate per peso', () => {
  const lhr = {
    finalDisplayedUrl: 'https://a.it/', lighthouseVersion: '12.8.2', configSettings: { formFactor: 'mobile' },
    categories: { performance: { score: 0.72, auditRefs: [{ id: 'largest-contentful-paint', weight: 25 }, { id: 'render-blocking-resources', weight: 0 }, { id: 'total-blocking-time', weight: 30 }] } },
    audits: {
      'largest-contentful-paint': { title: 'Largest Contentful Paint', score: 0.4, displayValue: '4.1 s' },
      'total-blocking-time': { title: 'Total Blocking Time', score: 0.95, displayValue: '90 ms' },
      'render-blocking-resources': { title: 'Eliminate render-blocking resources', score: 0.5, metricSavings: { LCP: 600 } },
    },
  };
  const s = summarizeLighthouse(lhr);
  assert.deepEqual(s.categories, { performance: 72 });
  assert.deepEqual(s.metrics['largest-contentful-paint'], { value: '4.1 s', score: 40 });
  assert.deepEqual(s.failing.map((f) => f.id), ['largest-contentful-paint', 'render-blocking-resources']);
  assert.deepEqual(s.failing[1].savings, { LCP: 600 });
});
