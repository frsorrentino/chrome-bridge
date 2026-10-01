/**
 * perf_trace lato server: legge lo stream a pezzi, scrive il trace su disco e
 * restituisce solo le conclusioni; su errore interrompe la registrazione.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

const TRACE = JSON.stringify({ traceEvents: [{ name: 'TracingStartedInBrowser', ph: 'I', pid: 1, tid: 1, ts: 1000, args: { data: { frames: [] } } }] });

function build(reply) {
  const handlers = new Map(); const sent = [];
  registerTools({ tool: (n, _d, s, ...rest) => handlers.set(n, { handler: rest[rest.length - 1], schema: s }) },
    { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t, p) => { sent.push({ type: t, params: p }); return reply(t, p); } }, 'all');
  return { handlers, sent };
}

test('record: start con reload, stop, lettura in due pezzi, file scritto, conclusioni nel risultato', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-trace-'));
  let reads = 0;
  const { handlers, sent } = build((t, p) => {
    if (t !== MessageType.PERF_TRACE) return {};
    if (p.op === 'read') {
      reads += 1;
      const half = Math.ceil(TRACE.length / 2);
      return reads === 1 ? { data: Buffer.from(TRACE.slice(0, half)).toString('base64'), base64: true, eof: false } : { data: TRACE.slice(half), base64: false, eof: true };
    }
    return { ok: true };
  });
  const save_to = join(dir, 't.json');
  const res = await handlers.get('perf_trace').handler({ action: 'record', duration_ms: 10, save_to });
  const ops = sent.filter((m) => m.type === MessageType.PERF_TRACE).map((m) => m.params.op);
  assert.deepEqual(ops, ['start', 'stop', 'read', 'read']);
  assert.equal(sent[0].params.reload, true);
  assert.equal(await readFile(save_to, 'utf8'), TRACE);
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.saved, save_to);
  assert.equal(data.events, 1);
  assert.equal(data.navigation, false);
});

test('start senza reload di default; stop fallito interrompe il trace', async () => {
  const { handlers, sent } = build((t, p) => {
    if (p?.op === 'stop') throw new Error('Trace did not complete within 30 s');
    return { tracing: true };
  });
  const started = JSON.parse((await handlers.get('perf_trace').handler({ action: 'start' })).content[0].text);
  assert.equal(started.reloaded, false);
  await assert.rejects(handlers.get('perf_trace').handler({ action: 'record', duration_ms: 1 }), /did not complete/);
  assert.equal(sent.at(-1).params.op, 'abort');
});
