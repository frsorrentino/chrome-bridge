/**
 * labelOf dà a get_interactives il nome visibile dei campi: prima <label for>,
 * <label> avvolgente e aria-labelledby erano ignorati (httpbin.org/forms/post,
 * 24/09/2026). Testata su un DOM finto, come findTextInPage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'node-html-parser';
import '../../extension/lib/element-label.js';

const labelOf = globalThis.__cbLabelOf;
const LABELABLE = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON']);

// DOM finto con el.labels calcolato come il browser: <label for=id> e
// <label> antenato, solo per gli elementi etichettabili.
function fakeDoc(html) {
  const root = parse(html);
  const cache = new Map();
  const adapt = (node) => {
    if (!node) return null;
    if (cache.has(node)) return cache.get(node);
    const isEl = node.nodeType === 1;
    const tagName = isEl ? (node.rawTagName || '').toUpperCase() : undefined;
    const out = {
      nodeType: node.nodeType,
      tagName,
      get textContent() { return isEl ? node.textContent : node.rawText; },
      get childNodes() { return node.childNodes.map(adapt); },
      get value() { return node.getAttribute('value') ?? ''; },
      getAttribute: (n) => (isEl ? node.getAttribute(n) ?? null : null),
      get labels() {
        if (!LABELABLE.has(tagName)) return undefined;
        const out = [];
        const id = node.getAttribute('id');
        if (id) out.push(...root.querySelectorAll(`label[for="${id}"]`));
        for (let p = node.parentNode; p; p = p.parentNode) if (p.rawTagName?.toUpperCase() === 'LABEL') { out.push(p); break; }
        return out.map(adapt);
      },
    };
    cache.set(node, out);
    return out;
  };
  return {
    getElementById: (id) => adapt(root.querySelector(`#${id}`)),
    $: (sel) => adapt(root.querySelector(sel)),
  };
}
const label = (html, sel) => { const d = fakeDoc(html); return labelOf(d.$(sel), d); };

test('<label> avvolgente: il testo della label, senza il campo', () => {
  assert.equal(label('<form><p><label>Customer name: <input name="custname"></label></p></form>', 'input'), 'Customer name:');
});

test('<label for>: il testo della label collegata', () => {
  assert.equal(label('<form><label for="t">Telephone</label><input id="t" type="tel"></form>', 'input'), 'Telephone');
});

test('aria-labelledby: il testo degli id citati, in ordine', () => {
  assert.equal(label('<div><span id="a">Delivery</span><span id="b">time</span><input aria-labelledby="a b"></div>', 'input'), 'Delivery time');
});

test('aria-label vince su tutto', () => {
  assert.equal(label('<label>Visible <input aria-label="Explicit" placeholder="p"></label>', 'input'), 'Explicit');
});

test('radio e checkbox: il testo della label, non il value', () => {
  assert.equal(label('<label><input type="radio" name="size" value="small"> Small </label>', 'input'), 'Small');
  assert.equal(label('<label><input type="checkbox" name="topping" value="bacon"> Bacon </label>', 'input'), 'Bacon');
});

test('select dentro la label: le opzioni non entrano nel nome', () => {
  assert.equal(label('<label>Size <select><option>Large</option><option>Small</option></select></label>', 'select'), 'Size');
});

test('bottoni: testo per <button>, value per input submit', () => {
  assert.equal(label('<form><button>  Submit   order </button></form>', 'button'), 'Submit order');
  assert.equal(label('<form><input type="submit" value="Send"></form>', 'input'), 'Send');
});

test('campo di testo senza label: title, poi placeholder, mai il value', () => {
  assert.equal(label('<input value="typed by user" title="Search">', 'input'), 'Search');
  assert.equal(label('<input value="typed by user" placeholder="Your e-mail">', 'input'), 'Your e-mail');
  assert.equal(label('<input value="typed by user">', 'input'), '');
});

test('link e altri elementi non campo: il testo', () => {
  assert.equal(label('<nav><a href="/x">Home\n  page</a></nav>', 'a'), 'Home page');
});

test('tetto a 80 caratteri, spazi normalizzati', () => {
  const long = 'Delivery instructions '.repeat(10);
  const out = label(`<label>${long}<textarea></textarea></label>`, 'textarea');
  assert.equal(out.length, 80);
  assert.ok(!/\s\s/.test(out));
});
