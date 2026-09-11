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
