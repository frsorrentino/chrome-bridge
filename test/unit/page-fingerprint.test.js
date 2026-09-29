/**
 * pageFingerprint gira nella pagina (chrome.scripting ne serializza il
 * sorgente, quindi è autocontenuta) e riassume in pochi interi lo stato che
 * un'azione può cambiare: quanti nodi, quanto testo, quanti elementi aperti,
 * espansi, spuntati, selezionati, quanti dialoghi, chi ha il fuoco. Il server
 * confronta l'impronta prima e dopo un click e dice al modello se la pagina
 * ha reagito, senza screenshot. Qui è testata su un DOM finto, come
 * buildMarkdown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'node-html-parser';
import { pageFingerprint } from '../../extension/lib/page-fingerprint.js';

function fakeDoc(html, { title = 'T', url = 'https://a.it/p', activeSelector = null } = {}) {
  const root = parse(html);
  const adapt = (node) => ({
    tagName: (node.rawTagName || '').toUpperCase(),
    id: node.getAttribute?.('id') ?? '',
    checked: node.hasAttribute?.('checked') ?? false,
    getAttribute: (n) => node.getAttribute(n) ?? null,
    querySelectorAll: (sel) => node.querySelectorAll(sel).map(adapt),
    textContent: node.textContent,
  });
  const body = adapt(root.querySelector('body') ?? root);
  return {
    title,
    location: { href: url },
    body,
    activeElement: activeSelector ? adapt(root.querySelector(activeSelector)) : body,
    querySelectorAll: (sel) => root.querySelectorAll(sel).map(adapt),
    getElementsByTagName: (t) => root.querySelectorAll(t === '*' ? '*' : t).map(adapt),
  };
}

test('conta nodi, testo, aperti, espansi, spuntati, selezionati, dialoghi', () => {
  const fp = pageFingerprint(fakeDoc(`<body>
    <details open><summary>x</summary>y</details>
    <button aria-expanded="true">m</button><button aria-expanded="false">n</button>
    <input type="checkbox" checked><input type="checkbox"><input type="radio" checked>
    <li aria-selected="true">a</li>
    <dialog open>d</dialog><div role="dialog">e</div>
  </body>`));
  assert.equal(fp.url, 'https://a.it/p');
  assert.equal(fp.title, 'T');
  assert.ok(fp.nodes >= 10, `nodes=${fp.nodes}`);
  assert.ok(fp.text > 0);
  assert.equal(fp.open, 2, 'details[open] e dialog[open]');
  assert.equal(fp.expanded, 1);
  assert.equal(fp.checked, 2);
  assert.equal(fp.selected, 1);
  assert.equal(fp.dialogs, 2, 'dialog[open] e role=dialog');
});

test('descrive l\'elemento col fuoco come tag#id, poi tag[name], poi tag', () => {
  assert.equal(pageFingerprint(fakeDoc('<body><input id="email"></body>', { activeSelector: '#email' })).focus, 'input#email');
  assert.equal(pageFingerprint(fakeDoc('<body><input name="q"></body>', { activeSelector: 'input' })).focus, 'input[name="q"]');
  assert.equal(pageFingerprint(fakeDoc('<body><button>x</button></body>', { activeSelector: 'button' })).focus, 'button');
  assert.equal(pageFingerprint(fakeDoc('<body><p>x</p></body>')).focus, 'body');
});

test('una pagina vuota dà zeri, non errori', () => {
  const fp = pageFingerprint(fakeDoc('<body></body>'));
  assert.equal(fp.open, 0); assert.equal(fp.expanded, 0); assert.equal(fp.checked, 0);
  assert.equal(fp.selected, 0); assert.equal(fp.dialogs, 0);
});

// settle: MutationObserver finto, perché node non ne ha uno. Le mutazioni si
// simulano chiamando il callback registrato.
function withFakeObserver(fn) {
  const prev = globalThis.MutationObserver;
  const observers = [];
  globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() { this.off = true; } };
  return Promise.resolve(fn(observers)).finally(() => { globalThis.MutationObserver = prev; });
}

test('settle: DOM fermo → risponde dopo quiet_ms, non dopo max_ms', () => withFakeObserver(async () => {
  const fp = await pageFingerprint(fakeDoc('<body><p>x</p></body>'), { quiet_ms: 30, max_ms: 1000 });
  assert.ok(fp.settled_ms >= 30 && fp.settled_ms < 900, `settled_ms=${fp.settled_ms}`);
  assert.equal(fp.title, 'T');
}));

test('settle: mutazioni continue → si ferma a max_ms', () => withFakeObserver(async (obs) => {
  // quiet_ms più lungo di max_ms: la quiete non può arrivare prima, sotto
  // qualunque carico; si misura solo che il tetto tenga.
  const pending = pageFingerprint(fakeDoc('<body><p>x</p></body>'), { quiet_ms: 5000, max_ms: 120 });
  const iv = setInterval(() => obs[0]?.cb([]), 5);
  const fp = await pending;
  clearInterval(iv);
  assert.ok(fp.settled_ms >= 120 && fp.settled_ms < 900, `settled_ms=${fp.settled_ms}`);
  assert.ok(obs[0].off, 'observer staccato');
}));

test('settle: pagina nascosta → subito, con hidden', () => withFakeObserver(() => {
  const doc = { ...fakeDoc('<body><p>x</p></body>'), hidden: true };
  const fp = pageFingerprint(doc, { quiet_ms: 30, max_ms: 120 });
  assert.equal(fp.settled_ms, 0);
  assert.equal(fp.hidden, true);
}));
