/**
 * screencast lato server: drena i fotogrammi mentre registra, li scrive su
 * disco e senza ffmpeg restituisce cartella e comando invece di fallire.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'cb-cast-'));
process.env.CHROME_BRIDGE_CAPTURES_DIR = dir;
process.env.CHROME_BRIDGE_FFMPEG = 'chrome-bridge-no-such-ffmpeg';
const { registerTools } = await import('../../server/tools.js');
const { MessageType } = await import('../../server/protocol.js');

const jpeg = Buffer.from('fake').toString('base64');

function build() {
  const handlers = new Map(); const sent = [];
  let n = 0;
  registerTools({ tool: (name, _d, s, ...rest) => handlers.set(name, { handler: rest[rest.length - 1], schema: s }) },
    { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: async (t, p) => {
      sent.push({ type: t, params: p });
      if (t !== MessageType.SCREENCAST) return {};
      if (p.op === 'drain' || p.op === 'stop') { n += 1; return { frames: [{ data: jpeg, t: 1000 + n * 0.1 }], total: n }; }
      return { recording: true };
    } }, 'all');
  return { handlers, sent };
}

test('record: start, drain durante la finestra, stop; senza ffmpeg cartella e comando', async () => {
  const { handlers, sent } = build();
  const res = await handlers.get('screencast').handler({ action: 'record', duration_ms: 900, format: 'mp4', fps: 30, quality: 70, max_width: 1280 });
  const ops = sent.filter((m) => m.type === MessageType.SCREENCAST).map((m) => m.params.op);
  assert.equal(ops[0], 'start');
  assert.ok(ops.includes('drain'), `nessun drain durante la finestra: ${ops}`);
  assert.equal(ops.at(-1), 'stop');
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.video, null);
  assert.match(data.error, /ffmpeg not found/);
  assert.match(data.command, /^ffmpeg .*-f concat/);
  const files = await readdir(data.frames_dir);
  assert.equal(files.filter((f) => f.endsWith('.jpg')).length, data.frames);
  assert.ok(files.includes('frames.ffconcat'));
});

test('stop senza start: errore chiaro; doppio start rifiutato', async () => {
  const { handlers } = build();
  await assert.rejects(handlers.get('screencast').handler({ action: 'stop', format: 'mp4', fps: 30 }), /No screencast running/);
  await handlers.get('screencast').handler({ action: 'start', quality: 70, max_width: 1280 });
  await assert.rejects(handlers.get('screencast').handler({ action: 'start', quality: 70, max_width: 1280 }), /already running/);
  await handlers.get('screencast').handler({ action: 'stop', format: 'mp4', fps: 30 });
});
