/**
 * window_layout dalla CLI: la stessa implementazione del tool MCP
 * (server/layouts.js), raggiungibile con `chrome-bridge window_layout
 * --action save --name X`. Prima la CLI rispondeva «Unknown command».
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LAYOUTS = join(tmpdir(), `cb-layouts-cli-test-${process.pid}.json`);
process.env.CHROME_BRIDGE_LAYOUTS_FILE = LAYOUTS;
const { parseCliArgs } = await import('../../server/cli.js');
const { windowLayout } = await import('../../server/layouts.js');
const { MessageType } = await import('../../server/protocol.js');

after(async () => { await rm(LAYOUTS, { force: true }); });

const SNAP = {
  tabs: [{ id: 1, url: 'https://a.test/', windowId: 10, active: true }],
  windows: [{ id: 10, type: 'normal', state: 'normal', left: 5, top: 6, width: 700, height: 500 }],
};

test('la CLI accetta window_layout come comando virtuale', () => {
  const { command, params } = parseCliArgs(['window_layout', '--action', 'save', '--name', 'mattina']);
  assert.equal(command, 'window_layout');
  assert.deepEqual(params, { action: 'save', name: 'mattina' });
});

test('save → list → restore con lo stesso send della CLI', async () => {
  const sent = [];
  const send = async (type, params) => { sent.push({ type, params }); return type === MessageType.GET_TABS ? SNAP : { window: params }; };
  assert.deepEqual(await windowLayout(send, { action: 'save', name: 'mattina' }), { saved: 'mattina', windows: 1 });
  const { layouts } = await windowLayout(send, { action: 'list' });
  assert.equal(layouts[0].name, 'mattina');
  const r = await windowLayout(send, { action: 'restore', name: 'mattina' });
  assert.equal(r.matched, 1);
  assert.equal(sent.filter((s) => s.type === MessageType.VIEWPORT_RESIZE).length, 1);
  assert.deepEqual(await windowLayout(send, { action: 'delete', name: 'mattina' }), { deleted: 'mattina', existed: true });
});
