/**
 * Distribuzione come plugin: Agent Plugins 1.0 (plugin.json + mcp.json alla
 * radice, standard vendor-neutral) e Claude Code (plugin/.claude-plugin/,
 * con il marketplace in .claude-plugin/ alla radice). Tre file in più che ripetono versione e comando: qui si
 * inchiodano a package.json, così una release che bumpa uno solo dei quattro
 * fallisce il test invece di pubblicare un plugin che installa la versione
 * vecchia.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const pkg = readJson('package.json');

test('plugin.json (Agent Plugins 1.0) identifica il plugin con la versione di package.json', () => {
  const plugin = readJson('plugin.json');
  assert.match(plugin.$schema, /agent-plugins\.org\/schemas\/1\.0\.0\/plugin\.schema\.json$/);
  assert.equal(plugin.name, 'chrome-bridge');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.license, pkg.license);
  assert.match(plugin.repository, /github\.com\/frsorrentino\/chrome-bridge/);
  for (const k of ['browser', 'chrome', 'mcp']) assert.ok(plugin.keywords.includes(k), `keyword ${k}`);
});

test('mcp.json (Agent Plugins 1.0) avvia il pacchetto npm alla stessa versione, col core di default', () => {
  const mcp = readJson('mcp.json');
  assert.match(mcp.$schema, /agent-plugins\.org\/schemas\/1\.0\.0\/mcp\.schema\.json$/);
  const srv = mcp.mcpServers['chrome-bridge'];
  assert.equal(srv.type, 'stdio');
  assert.equal(srv.command, 'npx');
  assert.ok(srv.args.includes(`chrome-bridge-mcp@${pkg.version}`), `args ${JSON.stringify(srv.args)} non fissano la versione ${pkg.version}`);
  // I gruppi opt-in si accendono a runtime (get_status enable): forzare all
  // costava schema in ogni sessione per 17 tool mai usati.
  assert.equal(srv.env?.CHROME_BRIDGE_CAPS, undefined);
});

test('plugin/.claude-plugin/plugin.json: stessa versione, skill e server incorporato nella cartella plugin/', () => {
  const plugin = readJson('plugin/.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'chrome-bridge');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.skills, './skills/');
  assert.ok(existsSync(join(ROOT, 'plugin', 'skills', 'chrome-bridge', 'SKILL.md')));
  const srv = plugin.mcpServers['chrome-bridge'];
  // Dal 26/11/2026 niente npx: il server gira da plugin/dist/, che la directory legge
  // (plugin-dir.test.js controlla che sia aggiornato e uguale a server/).
  assert.equal(srv.command, 'node');
  assert.deepEqual(srv.args, ['${CLAUDE_PLUGIN_ROOT}/dist/index.js']);
  assert.equal(srv.env?.CHROME_BRIDGE_CAPS, undefined);
  // Solo Claude Code: i tool del core arrivano senza ToolSearch (circa -2 turni a sessione).
  assert.equal(srv.alwaysLoad, true);
  assert.equal(existsSync(join(ROOT, '.claude-plugin', 'plugin.json')), false,
    'un secondo manifest alla radice: il plugin è plugin/');
});

test('.claude-plugin/marketplace.json pubblica il plugin dalla cartella plugin/', () => {
  const market = readJson('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'chrome-bridge');
  assert.ok(market.owner?.name);
  const entry = market.plugins.find((p) => p.name === 'chrome-bridge');
  assert.ok(entry, 'nessuna voce chrome-bridge nel marketplace');
  assert.equal(entry.source, './plugin');
});

test('le descrizioni dei manifest non ripetono il conteggio dei tool a mano', () => {
  // Il numero vive in tool-counts.test.js: qui una copia in più sarebbe solo
  // un altro posto dove diverge.
  for (const p of ['plugin.json', 'plugin/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
    const text = readFileSync(join(ROOT, p), 'utf8');
    assert.doesNotMatch(text, /\d{2,3}\s+tools?\b/i, `${p} cita un conteggio di tool`);
  }
});
