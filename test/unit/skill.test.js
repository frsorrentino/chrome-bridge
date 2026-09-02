/**
 * La skill è il contenitore delle ricette: sequenze di tool che il modello
 * legge quando l'utente dice "verifica che la mail arrivi" o "testa il
 * checkout". Una ricetta che nomina un tool rinominato, o un parametro che
 * non esiste, manda il modello a sbattere contro un errore di schema e brucia
 * un turno: qui ogni `tool({param})` citato nella skill viene controllato
 * contro i tool registrati davvero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { registerTools } from '../../server/tools.js';

const SKILL = readFileSync(new URL('../../skills/chrome-bridge/SKILL.md', import.meta.url), 'utf8');

function tools() {
  const out = new Map();
  registerTools(
    { tool: (name, _d, schema) => out.set(name, toJsonSchemaCompat(z.object(schema ?? {}), { strictUnions: true })) },
    { isConnected: () => false, mode: 'primary', host: '127.0.0.1', port: 8765, sendCommand: async () => ({}) },
    'all',
  );
  return out;
}
const TOOLS = tools();
// Comandi solo CLI, citati nella corsia a zero token
const CLI_ONLY = new Set(['replay', 'track', 'redirects', 'check_links', 'security_headers']);

test('la skill ha frontmatter con name e description', () => {
  assert.match(SKILL, /^---\nname: chrome-bridge\ndescription: .{80,}\n---/);
});

test('ogni ricetta dichiara le frasi che la innescano', () => {
  const sections = SKILL.split('\n### ').slice(1);
  const missing = sections.filter((s) => !/^.*\nTriggers?:/m.test(s)).map((s) => s.split('\n')[0]);
  assert.deepEqual(missing, [], 'ricette senza riga Triggers: il modello non sa quando proporle');
});

test('ogni tool citato come chiamata esiste, con i parametri che cita', () => {
  const problems = [];
  const re = /`([a-z_]+)\((\{[^`]*?\})?[^`]*\)`?/g;
  for (const m of SKILL.matchAll(re)) {
    const [, name, obj] = m;
    if (CLI_ONLY.has(name)) continue;
    const schema = TOOLS.get(name);
    if (!schema) { problems.push(`${name}: tool non registrato`); continue; }
    if (!obj) continue;
    // Solo le chiavi di primo livello: `where:{email:…}` è un valore, non un parametro
    const top = obj.replace(/\{[^{}]*\}/g, (m, off) => (off === 0 ? m : '{}'));
    const keys = [...top.matchAll(/(?:^|[{,\s])([a-z_]+)\s*:/g)].map((k) => k[1]);
    for (const k of keys) {
      if (!schema.properties?.[k]) problems.push(`${name}({${k}}): parametro inesistente`);
    }
  }
  assert.deepEqual(problems, []);
});

test('ogni comando della corsia CLI è un comando reale', () => {
  const cliSection = SKILL.split('## CLI lane')[1].split('## Out of reach')[0];
  const cmds = [...cliSection.matchAll(/`chrome-bridge ([a-z_]+)/g)].map((m) => m[1]);
  const unknown = cmds.filter((c) => !TOOLS.has(c) && !CLI_ONLY.has(c));
  assert.deepEqual(unknown, []);
});
