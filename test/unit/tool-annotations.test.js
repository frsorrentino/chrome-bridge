/**
 * Le annotations MCP (readOnlyHint, destructiveHint, idempotentHint,
 * openWorldHint) sono l'unico modo che l'agente ha di sapere COSA FA un tool al
 * mondo prima di chiamarlo. Senza, la scelta si basa solo sulla descrizione in
 * prosa: `click` e `read_page` sembrano equivalenti finché uno non cambia lo
 * stato della pagina.
 *
 * Qui si misura dal codice reale, catturando le chiamate a server.tool().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../../server/tools.js';

function captureTools() {
  const tools = [];
  const fakeServer = {
    // server.tool(name, description, schema, annotations?, handler)
    tool(name, desc, schema, maybeAnnotations) {
      tools.push({
        name,
        desc,
        schema,
        annotations: typeof maybeAnnotations === 'function' ? undefined : maybeAnnotations,
      });
    },
  };
  const fakeWs = {
    isConnected: () => false,
    mode: 'primary',
    host: '127.0.0.1',
    port: 8765,
    sendCommand: async () => ({}),
  };
  registerTools(fakeServer, fakeWs, 'all');
  return tools;
}

const TOOLS = captureTools();
const byName = new Map(TOOLS.map((t) => [t.name, t]));

// Tool che cambiano lo stato della pagina, della tab o del disco.
const MUTATING = [
  'click', 'type_text', 'fill_form', 'modify_dom', 'set_storage', 'navigate',
  'tab_action', 'upload_file', 'press_key', 'inject_css', 'create_tab',
  'drag_and_drop', 'hover', 'scroll', 'execute_js', 'save_page',
];

// Tool che osservano e basta: nessuna scrittura su pagina, tab o disco.
const READ_ONLY = [
  'read_page', 'get_tabs', 'query_dom', 'get_css_styles', 'screenshot', 'get_page_info',
  'audit', 'extract_table', 'find_text',
  'get_interactives', 'get_frames',
  'get_storage',
  'measure_spacing', 'element_screenshot', 'full_page_screenshot',
];

test('ogni tool dichiara le annotations MCP', () => {
  const missing = TOOLS
    .filter((t) => !t.annotations || typeof t.annotations.readOnlyHint !== 'boolean')
    .map((t) => t.name);
  assert.deepEqual(
    missing,
    [],
    `${missing.length}/${TOOLS.length} tool senza readOnlyHint: l'agente non sa se toccano la pagina`,
  );
});

test('i tool che mutano lo stato dichiarano readOnlyHint false', () => {
  for (const name of MUTATING) {
    const t = byName.get(name);
    assert.ok(t, `tool "${name}" non registrato: aggiorna la lista MUTATING`);
    assert.equal(t.annotations?.readOnlyHint, false, `${name} cambia lo stato, non è read-only`);
  }
});

test('i tool di sola osservazione dichiarano readOnlyHint true', () => {
  for (const name of READ_ONLY) {
    const t = byName.get(name);
    assert.ok(t, `tool "${name}" non registrato: aggiorna la lista READ_ONLY`);
    assert.equal(t.annotations?.readOnlyHint, true, `${name} non scrive nulla, va marcato read-only`);
  }
});

// get_status({enable}) accende gruppi di tool per la sessione e watch_dom
// installa un observer nella pagina: con ro() Glama leggeva le annotations
// come una contraddizione con la descrizione (Behavior 2/5).
test('get_status e watch_dom non si dichiarano di sola lettura', () => {
  for (const name of ['get_status', 'watch_dom']) {
    const t = byName.get(name);
    assert.ok(t, `tool "${name}" non registrato`);
    assert.equal(t.annotations?.readOnlyHint, false, `${name} cambia lo stato della sessione o della pagina`);
  }
  assert.equal(byName.get('get_status').annotations.idempotentHint, true, 'riaccendere un gruppo già acceso non cambia niente');
});

test('nessun tool è insieme read-only e distruttivo', () => {
  const contradictory = TOOLS
    .filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true)
    .map((t) => t.name);
  assert.deepEqual(contradictory, [], 'readOnlyHint e destructiveHint si escludono');
});

// I test sopra osservano un fake server: provano la nostra tabella, non che
// l'SDK inoltri davvero le annotations. Questo parla con un McpServer reale.
test('le annotations arrivano nella risposta tools/list', async () => {
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerTools(server, {
    isConnected: () => false, mode: 'primary', host: '127.0.0.1', port: 8765, sendCommand: async () => ({}),
  }, 'all');

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  const bare = tools.filter((t) => typeof t.annotations?.readOnlyHint !== 'boolean').map((t) => t.name);
  assert.deepEqual(bare, [], 'l\'SDK non sta inoltrando le annotations sul wire');

  const readPage = tools.find((t) => t.name === 'read_page');
  assert.equal(readPage.annotations.readOnlyHint, true);
  const tabAction = tools.find((t) => t.name === 'tab_action');
  assert.equal(tabAction.annotations.destructiveHint, true, 'tab_action può chiudere una tab');

  await client.close();
  await server.close();
});

// Ricontrollati il 19/11/2026 sul comportamento del codice, per il profilo di
// HOL Guard (hashgraph-online/hol-guard#8079) che li mette in «review».
// destructiveHint per la specifica MCP: il tool può fare modifiche non solo
// additive. Un click, un Enter o un invio di form possono cancellare o
// comprare; accettare un confirm() conferma l'azione che chiedeva; write della
// clipboard e record di network_rules sovrascrivono. openWorldHint: il tool
// può far partire richieste verso server remoti.
const SENSITIVE = {
  execute_js: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  click: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  type_text: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  fill_form: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  press_key: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  upload_file: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  http_request: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  webmcp_call: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  tab_action: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  network_rules: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  clipboard: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  handle_dialogs: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  get_status: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

test('annotations dei tool sensibili come ricontrollate', () => {
  for (const [name, expected] of Object.entries(SENSITIVE)) {
    const t = byName.get(name);
    assert.ok(t, `tool "${name}" non registrato`);
    assert.deepEqual(t.annotations, expected, `${name}: annotations diverse da quelle ricontrollate`);
  }
});

test('ogni tool dichiara anche idempotentHint e openWorldHint', () => {
  const incomplete = TOOLS
    .filter((t) => typeof t.annotations?.idempotentHint !== 'boolean'
      || typeof t.annotations?.openWorldHint !== 'boolean')
    .map((t) => t.name);
  assert.deepEqual(incomplete, [], 'annotations parziali: servono tutti e quattro gli hint');
});
