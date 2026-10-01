/**
 * heap_snapshot: istantanea dell'heap JS dalla porta CDP del browser lanciato
 * (HeapProfiler non è ammesso a chrome.debugger), sintesi per classe e
 * confronto fra due istantanee.
 *
 * Il formato .heapsnapshot è quello di DevTools: nodi in un array piatto con
 * i campi descritti in snapshot.meta.node_fields, nomi in strings. Il file si
 * apre anche in DevTools > Memory.
 */
import { createWriteStream } from 'node:fs';
import WebSocket from 'ws';

/** Client CDP minimo su un target della porta di debug. */
export function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(`${m.error.message} (${m.error.code})`)); else res(m.result);
      } else if (m.method) {
        for (const fn of listeners.get(m.method) ?? []) fn(m.params);
      }
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
      on: (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); },
      close: () => ws.close(),
    }));
  });
}

/** WebSocket del target con quell'id sulla porta locale. */
export async function targetWsUrl(port, targetId) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find((x) => x.id === targetId);
  if (!t?.webSocketDebuggerUrl) throw new Error(`Target ${targetId} not found on the DevTools port`);
  return t.webSocketDebuggerUrl;
}

/** Scrive l'istantanea su file man mano che arrivano i pezzi. Restituisce i byte scritti. */
export async function takeHeapSnapshot(cdp, path) {
  const out = createWriteStream(path);
  let bytes = 0;
  cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }) => { bytes += Buffer.byteLength(chunk); out.write(chunk); });
  await cdp.send('HeapProfiler.enable');
  // Un garbage collection prima: senza, l'istantanea conta anche oggetti già
  // irraggiungibili e il confronto fra due istantanee è rumore.
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
  await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));
  return bytes;
}

/**
 * Sintesi per classe: conteggio e dimensione propria. Gli oggetti si
 * raggruppano per costruttore, il resto per tipo, come la vista Summary di
 * DevTools; i nodi DOM staccati sono il segnale classico di una perdita.
 */
export function summarizeHeap(snapshot, { top = 15 } = {}) {
  const meta = snapshot.snapshot.meta;
  const f = meta.node_fields;
  const width = f.length;
  const iType = f.indexOf('type'); const iName = f.indexOf('name'); const iSize = f.indexOf('self_size');
  const iDetached = f.indexOf('detachedness');
  const types = meta.node_types[iType];
  const { nodes, strings } = snapshot;
  const byClass = new Map();
  let total = 0; let detached = 0; let count = 0;
  for (let i = 0; i < nodes.length; i += width) {
    const type = types[nodes[i + iType]];
    const size = nodes[i + iSize];
    const key = type === 'object' || type === 'native' ? strings[nodes[i + iName]] : `(${type})`;
    const c = byClass.get(key) ?? { count: 0, self_size: 0 };
    c.count += 1; c.self_size += size;
    byClass.set(key, c);
    total += size; count += 1;
    if (iDetached >= 0 && nodes[i + iDetached] === 2) detached += 1;
  }
  const classes = [...byClass.entries()].map(([name, c]) => ({ name, ...c })).sort((a, b) => b.self_size - a.self_size);
  return { nodes: count, total_self_size: total, detached_dom_nodes: detached, top: classes.slice(0, top), _all: byClass };
}

/** Confronto: le classi cresciute di più fra la prima istantanea e la seconda. */
export function diffHeap(before, after, { top = 15 } = {}) {
  const names = new Set([...before._all.keys(), ...after._all.keys()]);
  const rows = [];
  for (const name of names) {
    const a = before._all.get(name) ?? { count: 0, self_size: 0 };
    const b = after._all.get(name) ?? { count: 0, self_size: 0 };
    const d = { name, count_delta: b.count - a.count, size_delta: b.self_size - a.self_size };
    if (d.count_delta || d.size_delta) rows.push(d);
  }
  rows.sort((x, y) => y.size_delta - x.size_delta);
  return {
    total_size_delta: after.total_self_size - before.total_self_size,
    nodes_delta: after.nodes - before.nodes,
    detached_dom_delta: after.detached_dom_nodes - before.detached_dom_nodes,
    grown: rows.filter((r) => r.size_delta > 0).slice(0, top),
  };
}
