/**
 * Caricamento dei tool (Claude Code 2.1.285+): i tool fuori da EAGER_TOOLS
 * portano _meta['anthropic/alwaysLoad'] = false e restano dietro ToolSearch
 * anche quando il plugin carica il server per intero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools, EAGER_TOOLS } from '../../server/tools.js';

async function list(caps, options = {}) {
  const server = new McpServer({ name: 't', version: '0' });
  registerTools(server, { isConnected: () => true, mode: 'p', port: 1, sendCommand: async () => ({}) }, caps, options);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}
const deferred = (t) => t._meta?.['anthropic/alwaysLoad'] === false;

test('di default: i tool più usati caricati, gli altri rimandati', async () => {
  const tools = await list('core');
  const names = new Set(tools.map((t) => t.name));
  for (const n of EAGER_TOOLS) assert.ok(names.has(n), `${n} non è nel core`);
  const eager = tools.filter((t) => !deferred(t)).map((t) => t.name).sort();
  assert.deepEqual(eager, [...EAGER_TOOLS].sort());
  assert.ok(deferred(tools.find((t) => t.name === 'audit')), 'audit resta dietro ToolSearch');
  assert.ok(!deferred(tools.find((t) => t.name === 'extract_table')), 'extract_table caricato: ogni run heavy lo cercava');
});

test('CHROME_BRIDGE_ALWAYS_LOAD=all: nessun tool rimandato; una lista sceglie i caricati', async () => {
  assert.equal((await list('all', { alwaysLoad: 'all' })).filter(deferred).length, 0);
  const tools = await list('core', { alwaysLoad: 'navigate,click' });
  assert.deepEqual(tools.filter((t) => !deferred(t)).map((t) => t.name).sort(), ['click', 'navigate']);
});
