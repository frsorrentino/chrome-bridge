/**
 * Ogni func passata a executeScript viene serializzata, quindi
 * service-worker.js porta una copia inline di deepQuery per tool, generata da
 * extension/lib/deep-query.js: il test fallisce se una copia diverge dalla fonte.
 *
 * Il DOM è finto: node-html-parser, con <template shadowrootmode> trasformato
 * in shadowRoot dell'elemento che lo contiene, come fa il parser del browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'node-html-parser';

const SW = readFileSync(new URL('../../extension/service-worker.js', import.meta.url), 'utf8');

function attachShadows(root) {
  for (const tpl of root.querySelectorAll('template[shadowrootmode]')) {
    const host = tpl.parentNode;
    const shadow = parse(tpl.innerHTML);
    tpl.remove();
    shadow.host = host;
    host.shadowRoot = shadow;
    attachShadows(shadow);
  }
  return root;
}
const page = (html) => attachShadows(parse(html));

/** Gruppi di funzioni deepQuery/deepQueryAll consecutive in service-worker.js. */
function inlineGroups(text) {
  const lines = text.split('\n');
  const groups = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)function deepQuery(All)?\(/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1];
    const start = i;
    let end = i;
    for (;;) {
      while (lines[end] !== `${indent}}`) end++;
      let next = end + 1;
      while (next < lines.length && lines[next].trim() === '') next++;
      if (!new RegExp(`^${indent}function deepQuery(All)?\\(`).test(lines[next] ?? '')) break;
      end = next;
    }
    groups.push({ line: start + 1, text: lines.slice(start, end + 1).join('\n') });
    i = end;
  }
  return groups;
}

function load(text, doc) {
  // eslint-disable-next-line no-new-func
  return new Function('document', `${text}
    return {
      deepQuery: typeof deepQuery === 'function' ? deepQuery : undefined,
      deepQueryAll: typeof deepQueryAll === 'function' ? deepQueryAll : undefined,
    };`)(doc);
}

const GROUPS = inlineGroups(SW);

/** Esegue `check` con ogni implementazione: le copie inline e la fonte. */
async function eachImpl(html, check) {
  const doc = page(html);
  for (const g of GROUPS) check({ where: `service-worker.js:${g.line}`, ...load(g.text, doc) }, doc);
  const src = await import('../../extension/lib/deep-query.js').catch(() => null);
  assert.ok(src, 'extension/lib/deep-query.js manca');
  globalThis.document = doc;
  try {
    check({ where: 'extension/lib/deep-query.js', deepQuery: src.deepQuery, deepQueryAll: src.deepQueryAll }, doc);
  } finally {
    delete globalThis.document;
  }
}
const one = (impl, sel) => {
  const el = impl.deepQuery(sel);
  return el ? el.getAttribute('id') : null;
};
const all = (impl, sel) => impl.deepQueryAll(sel).map((el) => el.getAttribute('id'));
const host = (inner) => `<x-c><template shadowrootmode="open">${inner}</template></x-c>`;

test('le copie inline ci sono tutte: una per tool, più query_dom', () => {
  assert.ok(GROUPS.length >= 20, `trovate ${GROUPS.length} copie`);
});

test('ogni copia inline sta tra i marcatori deep-query ed è uguale alla fonte', async () => {
  const { syncDeepQuery } = await import('../../tools/sync-deep-query.mjs');
  const source = readFileSync(new URL('../../extension/lib/deep-query.js', import.meta.url), 'utf8');
  const r = syncDeepQuery(SW, source);
  assert.deepEqual(r.stray, [], 'deepQuery fuori dai marcatori: node tools/sync-deep-query.mjs non le aggiorna');
  assert.equal(r.regions, GROUPS.length);
  assert.ok(r.text === SW, 'copie diverse dalla fonte: lancia node tools/sync-deep-query.mjs');
});
