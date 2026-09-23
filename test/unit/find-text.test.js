/**
 * findTextInPage cerca sul testo degli elementi: le etichette spezzate in più
 * nodi (Meta Ads Manager, «Prestazioni e clic», 23/09/2026) prima non si
 * trovavano. Testata su un DOM finto, come pageFingerprint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'node-html-parser';
import { findTextInPage } from '../../extension/lib/find-text.js';

function fakeDoc(html) {
  const root = parse(html);
  const cache = new Map();
  const adapt = (node) => {
    if (cache.has(node)) return cache.get(node);
    const isEl = node.nodeType === 1;
    const out = {
      nodeType: node.nodeType,
      tagName: isEl ? (node.rawTagName || '').toUpperCase() : undefined,
      id: isEl ? node.getAttribute('id') ?? '' : undefined,
      classList: isEl ? (node.getAttribute('class') || '').split(/\s+/).filter(Boolean) : undefined,
      get textContent() { return isEl ? node.textContent : node.rawText.replace(/&nbsp;/g, ' '); },
      get childNodes() { return node.childNodes.map(adapt); },
      get children() { return node.childNodes.filter((c) => c.nodeType === 1).map(adapt); },
      querySelectorAll: () => [],
      shadowRoot: null,
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    };
    cache.set(node, out);
    return out;
  };
  return { body: adapt(root.querySelector('body')) };
}
const win = { scrollX: 0, scrollY: 0 };
const find = (html, needle, cs = false, max = 20) => findTextInPage(needle, cs, max, fakeDoc(html), win);

test('etichetta spezzata in più nodi: trovata una volta, sull\'elemento più interno che la contiene', () => {
  const r = find('<body><ul><li class="opt"><span>Prestazioni</span> e <b>clic</b></li><li>Altro</li></ul></body>', 'Prestazioni e clic');
  assert.equal(r.count, 1);
  assert.equal(r.matches[0].selector, 'li.opt');
  assert.equal(r.matches[0].context, 'Prestazioni e clic');
});

test('&nbsp; e spazi multipli contano come uno spazio; maiuscole ignorate di default', () => {
  const r = find('<body><div id="m">Prestazioni&nbsp;e   clic</div></body>', 'prestazioni e clic');
  assert.equal(r.count, 1);
  assert.equal(r.matches[0].selector, '#m');
});

test('testo in un solo nodo: riportato dal genitore diretto, non dagli antenati', () => {
  const r = find('<body><main><section><p id="t">Quantum Widget 1042</p></section></main></body>', 'Widget 1042');
  assert.deepEqual(r.matches.map((m) => m.selector), ['#t']);
});

test('più occorrenze in rami diversi, in ordine di documento, col tetto max_results', () => {
  const html = '<body><p id="a">Salva</p><div><span id="b">Salva</span></div><p id="c">Salva bozza</p></body>';
  assert.deepEqual(find(html, 'salva').matches.map((m) => m.selector), ['#a', '#b', '#c']);
  assert.equal(find(html, 'salva', false, 2).count, 2);
});

test('case_sensitive e script esclusi', () => {
  const html = '<body><p id="a">Salva</p><script>var x = "salva";</script></body>';
  assert.equal(find(html, 'salva', true).count, 0);
  assert.equal(find(html, 'Salva', true).count, 1);
});

test('caratteri speciali dell\'ago non diventano regex', () => {
  assert.equal(find('<body><p>Prezzo (IVA inclusa) 1.000 €</p></body>', '(IVA inclusa) 1.000').count, 1);
  assert.equal(find('<body><p>Prezzo 1x000</p></body>', '1.000').count, 0);
});
