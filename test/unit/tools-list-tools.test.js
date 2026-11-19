/**
 * L'elenco completo dei tool senza server né Chrome (`chrome-bridge list-tools`)
 * e gli inputSchema di tools/list senza "$schema".
 *
 * Perché: chi costruisce un profilo di permessi sui tool (HOL Guard,
 * hashgraph-online/hol-guard#8079) doveva catturare tools/list da un server
 * acceso, vedeva solo i gruppi attivi (46 su 69) e togliere a mano il
 * "$schema" draft-07 che l'SDK mette in testa a ogni inputSchema e che il suo
 * generatore rifiuta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools, describeTools, TOOL_CAPS } from '../../server/tools.js';

const CLI = fileURLToPath(new URL('../../server/cli.js', import.meta.url));
const GROUPS = new Set(['core', ...Object.keys(TOOL_CAPS)]);

async function wireTools(caps) {
  const server = new McpServer({ name: 't', version: '0' });
  registerTools(server, { isConnected: () => false, mode: 'primary', host: '127.0.0.1', port: 8765, sendCommand: async () => ({}) }, caps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

test('tools/list non porta "$schema" in nessun inputSchema', async () => {
  for (const caps of ['all', 'core']) {
    const tools = await wireTools(caps);
    const withDialect = tools.filter((t) => '$schema' in (t.inputSchema ?? {})).map((t) => t.name);
    assert.deepEqual(withDialect, [], `caps=${caps}: inputSchema con $schema`);
    assert.ok(tools.every((t) => t.inputSchema?.type === 'object'), `caps=${caps}: inputSchema non è più un oggetto`);
  }
});

test('describeTools elenca tutti i tool, gruppi opzionali compresi, come li manda tools/list', async () => {
  const listed = describeTools();
  const wire = await wireTools('all');
  assert.ok(listed.length >= 60, `solo ${listed.length} tool`);
  assert.deepEqual(listed.map((t) => t.name).sort(), wire.map((t) => t.name).sort(), 'elenco diverso da tools/list con caps=all');

  const optional = Object.values(TOOL_CAPS).flat();
  const names = new Set(listed.map((t) => t.name));
  assert.deepEqual(optional.filter((n) => !names.has(n)), [], 'mancano tool dei gruppi opzionali');

  const byWire = new Map(wire.map((t) => [t.name, t]));
  for (const t of listed) {
    assert.ok(GROUPS.has(t.group), `${t.name}: gruppo ${t.group}`);
    const expected = Object.entries(TOOL_CAPS).find(([, ns]) => ns.includes(t.name))?.[0] ?? 'core';
    assert.equal(t.group, expected, `${t.name}: gruppo sbagliato`);
    assert.deepEqual(t.annotations, byWire.get(t.name).annotations, `${t.name}: annotations diverse dal wire`);
    assert.deepEqual(t.inputSchema, byWire.get(t.name).inputSchema, `${t.name}: inputSchema diverso dal wire`);
    assert.equal(t.description, byWire.get(t.name).description, `${t.name}: descrizione diversa dal wire`);
  }
});

// La porta 1 non ha nessun server: se il comando provasse a collegarsi,
// fallirebbe invece di stampare l'elenco.
const runCli = (...args) => spawnSync(process.execPath, [CLI, 'list-tools', ...args], {
  encoding: 'utf8', timeout: 30000, env: { ...process.env, CHROME_BRIDGE_PORT: '1' },
});

test('chrome-bridge list-tools --format json: JSON completo senza server', () => {
  const r = runCli('--format', 'json');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('$schema'), '$schema nell\'output');
  const tools = JSON.parse(r.stdout);
  assert.deepEqual(tools, JSON.parse(JSON.stringify(describeTools())));
  for (const n of ['execute_js', 'click', 'get_status', 'clipboard', 'handle_dialogs', 'cookie_audit', 'heap_snapshot']) {
    assert.ok(tools.some((t) => t.name === n), `${n} manca`);
  }
});

// npm e npx installano il bin come symlink (node_modules/.bin/chrome-bridge →
// ../chrome-bridge-mcp/server/cli.js): process.argv[1] è il link, non il file.
// Con il confronto sul percorso nudo la CLI usciva 0 senza fare niente.
test('la CLI parte anche chiamata da un symlink, come la installa npm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cb-bin-'));
  const link = join(dir, 'chrome-bridge');
  symlinkSync(CLI, link);
  try {
    const r = spawnSync(process.execPath, [link, 'list-tools', '--format', 'json'], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, CHROME_BRIDGE_PORT: '1' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).length >= 60, 'output vuoto o incompleto dal symlink');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chrome-bridge list-tools senza --format: una riga per tool con gruppo e hint', () => {
  const r = runCli();
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  const all = describeTools();
  assert.equal(lines.length, all.length);
  const click = lines.find((l) => l.split('\t')[0] === 'click');
  assert.ok(click, 'riga di click mancante');
  assert.equal(click.split('\t')[1], 'core');
  assert.match(click, /destructive/);
  const page = lines.find((l) => l.split('\t')[0] === 'read_page');
  assert.match(page, /read-only/);
});
