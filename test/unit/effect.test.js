/**
 * fingerprintDelta: da due impronte di pagina (prima/dopo un'azione) a un
 * oggetto compatto con SOLO ciò che è cambiato, o null. È quello che il modello
 * legge in page_changed: costa zero quando la pagina è stabile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintDelta } from '../../server/effect.js';

const base = { url: 'https://a.it/', title: 'A', nodes: 100, text: 2000, open: 0, expanded: 0, checked: 1, selected: 0, dialogs: 0, focus: 'body' };

test('nessuna differenza → null', () => {
  assert.equal(fingerprintDelta(base, { ...base }), null);
});

test('un dropdown che si apre: expanded +1, nodi in più, fuoco spostato', () => {
  const d = fingerprintDelta(base, { ...base, expanded: 1, nodes: 112, focus: 'ul#menu' });
  assert.deepEqual(d, { nodes: '+12', expanded: '+1', focus: 'ul#menu' });
});

test('una navigazione: url e title nuovi, i conteggi in delta con segno', () => {
  const d = fingerprintDelta(base, { ...base, url: 'https://a.it/done', title: 'Done', nodes: 40, text: 300, checked: 0 });
  assert.deepEqual(d, { url: 'https://a.it/done', title: 'Done', nodes: '-60', text: '-1700', checked: '-1' });
});

test('impronte parziali (estensione vecchia: solo url/title) confrontano solo ciò che hanno', () => {
  assert.deepEqual(fingerprintDelta({ url: 'a', title: 't' }, { url: 'b', title: 't' }), { url: 'b' });
  assert.equal(fingerprintDelta({ url: 'a', title: 't' }, { url: 'a', title: 't', nodes: 5 }), null, 'un campo assente prima non è un cambiamento');
});

test('senza una delle due impronte → null', () => {
  assert.equal(fingerprintDelta(null, base), null);
  assert.equal(fingerprintDelta(base, undefined), null);
});
