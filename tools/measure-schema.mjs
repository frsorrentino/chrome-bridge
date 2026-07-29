#!/usr/bin/env node
/**
 * Misura deterministica del costo di schema dei tool MCP.
 *
 * Fonte di verità unica per i numeri pubblicati in README, RESULTS e listing:
 * carica il modulo reale `server/tools.js`, cattura ogni
 * server.tool(name, desc, schema, handler) e serializza lo schema con lo STESSO
 * converter dell'SDK MCP (toJsonSchemaCompat) — byte reali, non stime.
 *
 * Il conteggio dei tool era divergente in cinque punti del repo (59 / 56 / 30):
 * `test/unit/tool-counts.test.js` confronta questi numeri con i documenti e
 * fallisce quando si separano.
 *
 * Uso:
 *   node tools/measure-schema.mjs            # riepilogo leggibile
 *   node tools/measure-schema.mjs --json     # JSON completo (per script/CI)
 *   node tools/measure-schema.mjs --caps core
 */
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { registerTools, TOOL_CAPS } from '../server/tools.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const capsIdx = argv.indexOf('--caps');
const caps = capsIdx !== -1 ? argv[capsIdx + 1] : 'all';

const B = (s) => Buffer.byteLength(s ?? '', 'utf8');

export function measure(capsFilter = 'all') {
  const captured = [];
  const fakeServer = { tool(name, desc, schema) { captured.push({ name, desc, schema }); } };
  const fakeWs = { isConnected: () => false, mode: 'primary', host: '127.0.0.1', port: 8765, sendCommand: async () => ({}) };
  registerTools(fakeServer, fakeWs, capsFilter);

  const toolToCap = new Map();
  for (const [group, names] of Object.entries(TOOL_CAPS)) for (const n of names) toolToCap.set(n, group);

  const tools = captured.map((t) => {
    const js = toJsonSchemaCompat(z.object(t.schema ?? {}), { strictUnions: true });
    const schemaJson = JSON.stringify(js);
    const props = js.properties ? Object.keys(js.properties) : [];
    const required = js.required ?? [];
    // Payload MCP reale per tool: {"name":..,"description":..,"inputSchema":..}
    const wire = JSON.stringify({ name: t.name, description: t.desc, inputSchema: js });
    return {
      name: t.name,
      cap: toolToCap.get(t.name) ?? 'core',
      name_bytes: B(t.name),
      desc_bytes: B(t.desc),
      schema_bytes: B(schemaJson),
      total_bytes: B(t.name) + B(t.desc) + B(schemaJson),
      wire_bytes: B(wire),
      n_params: props.length,
      n_required: required.length,
      n_optional: props.length - required.length,
    };
  });

  const sum = (key, list = tools) => list.reduce((a, t) => a + t[key], 0);
  const byCap = {};
  for (const t of tools) {
    const c = (byCap[t.cap] ??= { n: 0, total_bytes: 0, wire_bytes: 0, names: [] });
    c.n += 1; c.total_bytes += t.total_bytes; c.wire_bytes += t.wire_bytes; c.names.push(t.name);
  }

  return {
    caps: capsFilter,
    totals: {
      n_tools: tools.length,
      sum_name_bytes: sum('name_bytes'),
      sum_desc_bytes: sum('desc_bytes'),
      sum_schema_bytes: sum('schema_bytes'),
      sum_total_bytes: sum('total_bytes'),
      sum_wire_bytes: sum('wire_bytes'),
      // 4 byte/token è l'euristica usata anche nei confronti pubblicati:
      // approssimata per costruzione, ma applicata identica a noi e agli altri.
      est_tokens: Math.round(sum('wire_bytes') / 4),
      n_required: sum('n_required'),
      n_optional: sum('n_optional'),
    },
    byCap,
    tools: tools.sort((a, b) => b.total_bytes - a.total_bytes),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = measure(caps);
  if (asJson) {
    process.stdout.write(JSON.stringify(all, null, 2) + '\n');
  } else {
    const t = all.totals;
    console.log(`caps=${all.caps}: ${t.n_tools} tool`);
    console.log(`  nome+descrizione+schema : ${t.sum_total_bytes} B`);
    console.log(`  payload tools/list      : ${t.sum_wire_bytes} B (~${(t.est_tokens / 1000).toFixed(1)}k token @4B)`);
    console.log(`  di cui schema           : ${t.sum_schema_bytes} B (${Math.round(t.sum_schema_bytes / t.sum_total_bytes * 100)}%)`);
    console.log(`  di cui descrizioni      : ${t.sum_desc_bytes} B (${Math.round(t.sum_desc_bytes / t.sum_total_bytes * 100)}%)`);
    console.log(`  parametri               : ${t.n_required} obbligatori, ${t.n_optional} opzionali`);
    console.log('\nper gruppo:');
    for (const [cap, c] of Object.entries(all.byCap).sort((a, b) => b[1].total_bytes - a[1].total_bytes)) {
      console.log(`  ${cap.padEnd(8)} ${String(c.n).padStart(2)} tool  ${String(c.total_bytes).padStart(6)} B`);
    }
    console.log('\ntop 10 per costo:');
    for (const x of all.tools.slice(0, 10)) {
      console.log(`  ${x.name.padEnd(24)} ${String(x.total_bytes).padStart(5)} B  (desc ${x.desc_bytes}, schema ${x.schema_bytes})`);
    }
  }
}
