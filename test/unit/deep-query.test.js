/**
 * «A >>> B» è un combinatore discendente che attraversa gli shadow root: B si
 * cerca sotto ogni elemento che A trova, nel suo shadowRoot, nel suo light DOM
 * e in ogni shadow root più in basso. Fino alla 1.32.3 B si cercava solo nello
 * shadowRoot del primo elemento di A, e «main >>> span» con lo span dentro un
 * componente sotto main non trovava niente (note observe chrome-bridg-6379570f,
 * chrome-bridg-f262acc4).
 *
 * Ogni func passata a executeScript viene serializzata, quindi
 * service-worker.js porta una copia inline di deepQuery per tool. I casi girano
 * su ogni copia estratta dal file e sulla fonte extension/lib/deep-query.js; un
 * test a parte fallisce se una copia diverge dalla fonte.
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

test('nota chrome-bridg-6379570f: «main >>> span.aru-text.aru-text-md» con main antenato dell\'host', () =>
  eachImpl(`<main><div>${host('<span id="s" class="aru-text aru-text-md">Ok</span>')}</div></main>`, (impl) => {
    if (impl.deepQuery) assert.equal(one(impl, 'main >>> span.aru-text.aru-text-md'), 's', impl.where);
    if (impl.deepQueryAll) assert.deepEqual(all(impl, 'main >>> span.aru-text.aru-text-md'), ['s'], impl.where);
  }));

test('nota chrome-bridg-f262acc4: «div[role=dialog] >>> span» attraverso due shadow root', () =>
  eachImpl(`<div role="dialog"><p>${host(`<section>${host('<span id="s">Chiudi</span>')}</section>`)}</p></div>`, (impl) => {
    if (impl.deepQuery) assert.equal(one(impl, 'div[role=dialog] >>> span'), 's', impl.where);
    if (impl.deepQueryAll) assert.deepEqual(all(impl, 'div[role=dialog] >>> span'), ['s'], impl.where);
  }));

test('B nel light DOM sotto A si trova anche senza shadow root', () =>
  eachImpl('<main><p><span id="s">luce</span></p></main>', (impl) => {
    if (impl.deepQuery) assert.equal(one(impl, 'main >>> span'), 's', impl.where);
    if (impl.deepQueryAll) assert.deepEqual(all(impl, 'main >>> span'), ['s'], impl.where);
  }));

test('si cercano tutti gli elementi che A trova, non solo il primo', () =>
  eachImpl(`<section id="a"><p>vuota</p></section><section id="b">${host('<b id="t">x</b>')}</section>`, (impl) => {
    if (impl.deepQuery) assert.equal(one(impl, 'section >>> b'), 't', impl.where);
    if (impl.deepQueryAll) assert.deepEqual(all(impl, 'section >>> b'), ['t'], impl.where);
  }));

test('deepQueryAll: luce e shadow root di ogni livello, senza doppioni', () =>
  eachImpl(`<main><span id="l">1</span>${host(`<span id="s1">2</span>${host('<span id="s2">3</span>')}`)}<div><span id="l2">4</span></div></main>`, (impl) => {
    if (!impl.deepQueryAll) return;
    assert.deepEqual(all(impl, 'main >>> span').sort(), ['l', 'l2', 's1', 's2'], impl.where);
    // main dentro main: lo scope interno non raddoppia i risultati
    assert.deepEqual(all(impl, 'main, div >>> span').sort(), ['l', 'l2', 's1', 's2'], impl.where);
  }));

test('fuori da A non si cerca: né nel light DOM né negli shadow root di un ramo accanto', () =>
  eachImpl(`<div id="left"><p>niente</p></div><div id="right"><span id="s">x</span>${host('<span id="t">y</span>')}</div>`, (impl) => {
    if (impl.deepQuery) assert.equal(one(impl, '#left >>> span'), null, impl.where);
    if (impl.deepQueryAll) assert.deepEqual(all(impl, '#left >>> span'), [], impl.where);
  }));

test('host con B sia nello shadowRoot sia nel light DOM: vince lo shadowRoot, come prima', () =>
  eachImpl('<my-app><button id="luce" class="save">slot</button><template shadowrootmode="open"><button id="ombra" class="save">Salva</button><slot></slot></template></my-app>', (impl) => {
    if (impl.deepQuery) assert.equal(one(impl, 'my-app >>> button.save'), 'ombra', impl.where);
    if (impl.deepQueryAll) assert.deepEqual(all(impl, 'my-app >>> button.save'), ['ombra', 'luce'], impl.where);
  }));

test('catena di host come nell\'e2e: «#l1 >>> #l2 >>> #l3 >>> #a»', () =>
  eachImpl('<div id="l1"><template shadowrootmode="open"><div id="l2"><template shadowrootmode="open"><div id="l3"><template shadowrootmode="open"><p id="a">Alfa</p></template></div></template></div></template></div>', (impl) => {
    if (impl.deepQuery) assert.equal(one(impl, '#l1 >>> #l2 >>> #l3 >>> #a'), 'a', impl.where);
    if (impl.deepQueryAll) assert.deepEqual(all(impl, '#l1 >>> #l2 >>> #l3 >>> #a'), ['a'], impl.where);
    // salto di un livello: #l1 >>> #a ora arriva fino in fondo
    if (impl.deepQuery) assert.equal(one(impl, '#l1 >>> #a'), 'a', impl.where);
  }));

test('senza ">>>" niente cambia: solo il light DOM del documento', () =>
  eachImpl(`<main><span id="l">1</span>${host('<span id="s">2</span>')}</main>`, (impl) => {
    if (impl.deepQuery) assert.equal(one(impl, 'main span'), 'l', impl.where);
    if (impl.deepQueryAll) assert.deepEqual(all(impl, 'span'), ['l'], impl.where);
  }));

test('un selettore non valido lancia ancora: notFoundError lo trasforma in «Invalid selector»', () =>
  eachImpl('<main></main>', (impl) => {
    if (impl.deepQuery) assert.throws(() => impl.deepQuery('main >>> span >> nth=0'), undefined, impl.where);
  }));

test('ogni copia inline sta tra i marcatori deep-query ed è uguale alla fonte', async () => {
  const { syncDeepQuery } = await import('../../tools/sync-deep-query.mjs');
  const source = readFileSync(new URL('../../extension/lib/deep-query.js', import.meta.url), 'utf8');
  const r = syncDeepQuery(SW, source);
  assert.deepEqual(r.stray, [], 'deepQuery fuori dai marcatori: node tools/sync-deep-query.mjs non le aggiorna');
  assert.equal(r.regions, GROUPS.length);
  assert.ok(r.text === SW, 'copie diverse dalla fonte: lancia node tools/sync-deep-query.mjs');
});
