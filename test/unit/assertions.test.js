import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAssert, matchPattern } from '../../server/assertions.js';

function fakeSend(canned) {
  const calls = [];
  const send = async (type, params) => {
    calls.push({ type, params });
    if (typeof canned[type] === 'function') return canned[type](params);
    if (!(type in canned)) throw new Error(`No canned response for ${type}`);
    return canned[type];
  };
  send.calls = calls;
  return send;
}

const el = (text, w = 10, h = 10) => ({ textContent: text, rect: { x: 0, y: 0, width: w, height: h } });

test('matchPattern: substring e /regex/', () => {
  assert.ok(matchPattern('https://x.test/done?ok=1', '/done'));
  assert.ok(matchPattern('https://x.test/done', '/\\/done$/'));
  assert.ok(!matchPattern('https://x.test/form', '/\\/done$/'));
});

test('assert element attached + text nel selettore', async () => {
  const send = fakeSend({ query_dom: { count: 1, elements: [el('Thank you! Reference: ACME-2291')] } });
  const r = await runAssert(send, { selector: '#success', text: 'ACME-2291' });
  assert.equal(r.passed, true);
});

test('assert visible fallisce su elemento 0x0, poi passa al retry', async () => {
  let call = 0;
  const send = fakeSend({ query_dom: () => ({ count: 1, elements: [el('x', call++ > 0 ? 10 : 0, call > 1 ? 10 : 0)] }) });
  const r = await runAssert(send, { selector: '#panel', state: 'visible', timeout: 2000, interval: 10 });
  assert.equal(r.passed, true);
  assert.ok(send.calls.length >= 2, 'ha fatto polling');
});

test('assert count esatto: rileva sia in meno che in più', async () => {
  const two = { count: 2, elements: [el('a'), el('b')] };
  await assert.rejects(
    runAssert(fakeSend({ query_dom: two }), { selector: 'tr', count: 3, timeout: 50, interval: 10 }),
    /count 2 != 3/
  );
  const r = await runAssert(fakeSend({ query_dom: two }), { selector: 'tr', count: 2 });
  assert.equal(r.passed, true);
});

test('assert url con regex sul tab di sessione', async () => {
  const send = fakeSend({ get_tabs: [
    { id: 1, active: true, url: 'https://user.test/altro', title: 'Altro' },
    { id: 7, active: false, url: 'https://x.test/checkout/done', title: 'Done' },
  ] });
  const r = await runAssert(send, { url: '/checkout\\/done/', tab_id: 7 });
  assert.equal(r.passed, true);
  // Senza tab_id: guarda il tab attivo → fallisce
  await assert.rejects(runAssert(send, { url: '/checkout/', timeout: 50, interval: 10 }), /does not match/);
});

test('assert text pagina intera via find_text; fallimento con dettaglio', async () => {
  const ok = await runAssert(fakeSend({ find_text: { count: 3 } }), { text: 'Benvenuto' });
  assert.equal(ok.passed, true);
  await assert.rejects(
    runAssert(fakeSend({ find_text: { count: 0 } }), { text: 'Errore fatale', timeout: 50, interval: 10 }),
    /Assertion failed after 50ms: text "Errore fatale" not found on page/
  );
});

test('assert senza criteri erra subito', async () => {
  await assert.rejects(runAssert(fakeSend({}), { timeout: 50 }), /requires at least one/);
});
