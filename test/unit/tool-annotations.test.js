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
  'read_page', 'get_tabs', 'query_dom', 'screenshot', 'get_page_info',
  'seo_audit', 'accessibility_audit', 'extract_table', 'find_text',
  'web_vitals', 'get_performance', 'get_interactives', 'get_frames',
  'get_status', 'get_storage', 'security_headers', 'list_event_listeners',
  'unused_css', 'measure_spacing', 'element_screenshot', 'full_page_screenshot',
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

test('ogni tool dichiara anche idempotentHint e openWorldHint', () => {
  const incomplete = TOOLS
    .filter((t) => typeof t.annotations?.idempotentHint !== 'boolean'
      || typeof t.annotations?.openWorldHint !== 'boolean')
    .map((t) => t.name);
  assert.deepEqual(incomplete, [], 'annotations parziali: servono tutti e quattro gli hint');
});
