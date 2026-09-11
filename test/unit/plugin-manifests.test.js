/**
 * Distribuzione come plugin: Agent Plugins 1.0 (plugin.json + mcp.json alla
 * radice, standard vendor-neutral) e Claude Code (.claude-plugin/ con
 * marketplace). Tre file in più che ripetono versione e comando: qui si
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

test('mcp.json (Agent Plugins 1.0) avvia il pacchetto npm alla stessa versione, con tutte le capability', () => {
  const mcp = readJson('mcp.json');
  assert.match(mcp.$schema, /agent-plugins\.org\/schemas\/1\.0\.0\/mcp\.schema\.json$/);
  const srv = mcp.mcpServers['chrome-bridge'];
  assert.equal(srv.type, 'stdio');
  assert.equal(srv.command, 'npx');
  assert.ok(srv.args.includes(`chrome-bridge-mcp@${pkg.version}`), `args ${JSON.stringify(srv.args)} non fissano la versione ${pkg.version}`);
  assert.equal(srv.env.CHROME_BRIDGE_CAPS, 'all', 'senza caps=all il plugin espone 38 tool su 59, come install.sh sa già');
});

test('.claude-plugin/plugin.json: stessa versione, skill del repo, server npm con tutte le capability', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'chrome-bridge');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.skills, './skills/');
  assert.ok(existsSync(join(ROOT, 'skills', 'chrome-bridge', 'SKILL.md')));
  const srv = plugin.mcpServers['chrome-bridge'];
  assert.equal(srv.command, 'npx');
  assert.ok(srv.args.includes(`chrome-bridge-mcp@${pkg.version}`));
  assert.equal(srv.env.CHROME_BRIDGE_CAPS, 'all');
});

test('.claude-plugin/marketplace.json pubblica il plugin dalla radice del repo', () => {
  const market = readJson('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'chrome-bridge');
  assert.ok(market.owner?.name);
  const entry = market.plugins.find((p) => p.name === 'chrome-bridge');
  assert.ok(entry, 'nessuna voce chrome-bridge nel marketplace');
  assert.equal(entry.source, './');
});

test('le descrizioni dei manifest non ripetono il conteggio dei tool a mano', () => {
  // Il numero vive in tool-counts.test.js: qui una copia in più sarebbe solo
  // un altro posto dove diverge.
  for (const p of ['plugin.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
    const text = readFileSync(join(ROOT, p), 'utf8');
    assert.doesNotMatch(text, /\d{2,3}\s+tools?\b/i, `${p} cita un conteggio di tool`);
  }
});
