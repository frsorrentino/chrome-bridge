/**
 * Ogni parametro deve avere un `.describe()`.
 *
 * Lo schema JSON dice la STRUTTURA (tipo, enum, default) ma non l'intento:
 * `selector` non dice che accetta il piercing shadow-DOM con ">>>",
 * `tab_id` non dice cosa succede se lo ometti. L'agente sbaglia la prima
 * chiamata e ne spende una seconda per scoprirlo.
 *
 * Misurato prima di questo test: 88/254 parametri descritti (35%), 17 tool a
 * copertura zero. L'audit di Glama lo quantifica per tool — su `http_auth`,
 * "three parameters with 0% description coverage", Parameters 1/5.
 *
 * Il tetto sulla lunghezza serve al verso opposto: la stessa rubrica pesa la
 * concisione, e un `.describe()` che spiega troppo costa token su ogni
 * `tools/list` senza aggiungere nulla.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { registerTools } from '../../server/tools.js';

function schemas() {
  const out = [];
  registerTools(
    { tool: (name, _desc, schema) => out.push({ name, schema: schema ?? {} }) },
    { isConnected: () => false, mode: 'primary', host: '127.0.0.1', port: 8765, sendCommand: async () => ({}) },
    'all',
  );
  return out.map(({ name, schema }) => {
    const js = toJsonSchemaCompat(z.object(schema), { strictUnions: true });
    return { name, props: Object.entries(js.properties ?? {}), required: js.required ?? [] };
  });
}

const TOOLS = schemas();
const MAX_DESCRIBE = 130;

test('ogni parametro di ogni tool ha una descrizione', () => {
  const gaps = TOOLS
    .map(({ name, props }) => ({ name, missing: props.filter(([, v]) => !v?.description).map(([k]) => k) }))
    .filter((t) => t.missing.length)
    .map((t) => `${t.name}: ${t.missing.join(', ')}`);
  assert.deepEqual(gaps, [], `parametri senza .describe() in ${gaps.length} tool`);
});

test('nessuna descrizione di parametro è un tema', () => {
  const verbose = TOOLS.flatMap(({ name, props }) => props
    .filter(([, v]) => (v?.description?.length ?? 0) > MAX_DESCRIBE)
    .map(([k, v]) => `${name}.${k} (${v.description.length})`));
  assert.deepEqual(verbose, [], `oltre ${MAX_DESCRIBE} caratteri: la concisione è una voce della rubrica`);
});

test('i parametri ubiqui sono descritti allo stesso modo in tutti i tool', () => {
  // Copia-incolla divergente su tab_id/frame_id significa che un tool dice una
  // cosa e il gemello un'altra: l'agente non può fidarsi di nessuno dei due.
  //
  // Il confronto vale sulle occorrenze OPZIONALI, che sono quelle che portano il
  // contratto del target implicito ("se omesso, la tab di sessione"). Dove il
  // parametro è obbligatorio non c'è nessun default da descrivere e il testo
  // deve dire altro: move_tab(tab_id) è "quale scheda spostare", non "se omesso".
  for (const param of ['tab_id', 'frame_id']) {
    const texts = new Set(
      TOOLS.flatMap(({ name, props, required }) => props
        .filter(([k]) => k === param && !required.includes(k))
        .map(([, v]) => v?.description)),
    );
    assert.equal(texts.size, 1, `${param} opzionale è descritto in ${texts.size} modi diversi: ${[...texts].join(' /// ')}`);
  }
});

test('un parametro obbligatorio non promette un comportamento di default', () => {
  // "omitted = ..." su un parametro che non si può omettere è una bugia che
  // l'agente scopre solo dopo aver sbagliato la chiamata.
  const lying = TOOLS.flatMap(({ name, props, required }) => props
    .filter(([k, v]) => required.includes(k) && /\bomit(ted)?\b/i.test(v?.description ?? ''))
    .map(([k]) => `${name}.${k}`));
  assert.deepEqual(lying, [], 'parametri obbligatori che descrivono un default inesistente');
});
