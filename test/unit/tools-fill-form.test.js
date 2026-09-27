/**
 * fill_form: ref al posto dei selettori ed esito dell'invio.
 * Nel benchmark del 27/09/2026 il modello passava a fill_form i ref appena
 * dati da navigate (rifiutati dallo schema: un turno perso) e dopo l'invio
 * spendeva 1-3 turni fra find_text, extract e read_page per leggere la
 * conferma.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../../server/tools.js';

function setup(canned) {
  const handlers = new Map();
  const schemas = new Map();
  const sent = [];
  registerTools({ tool: (name, _d, schema, ...rest) => { handlers.set(name, rest[rest.length - 1]); schemas.set(name, schema); } }, {
    isConnected: () => true,
    mode: 'primary',
    port: 8765,
    sendCommand: async (type, params) => {
      sent.push({ type, params });
      const c = canned[type];
      if (typeof c === 'function') return c(params);
      if (c === undefined) throw new Error(`No canned response for ${type}`);
      return structuredClone(c);
    },
  }, 'all');
  return { handlers, schemas, sent };
}

const textOf = (r) => r.content.find((c) => c.type === 'text')?.text;
const input = (selector, y) => ({ selector, tag: 'input', text: selector, enabled: true, visible: true, rect: { x: 10, y, width: 50, height: 20 } });
const FORM_TEXT = 'Registrazione cliente\nNome\nEmail\nRegistra';
const DONE_TEXT = 'Registrazione cliente\nNome\nEmail\nRegistra\nRegistrazione completata\nRegistrato: Mario Rossi';

function formPage({ afterSubmit = DONE_TEXT } = {}) {
  let submitted = false;
  return {
    navigate: { url: 'http://localhost:8099/form.html', title: 'Registrazione', tabId: 7 },
    get_interactives: { count: 3, elements: [input('#nome', 10), input('#email', 40), input('#invia', 70)] },
    get_tabs: [{ id: 7, active: true, url: 'http://localhost:8099/form.html', title: 'Registrazione' }],
    read_page: () => (submitted ? afterSubmit : FORM_TEXT),
    fill_form: (p) => {
      if (p.submit_selector) submitted = true;
      return { fields: p.fields.map((f) => ({ selector: f.selector, success: true, mismatch: false, value_after: f.value })), submitted: !!p.submit_selector };
    },
  };
}

test('fill_form accetta i ref che navigate ha appena restituito, anche per il submit', async () => {
  const { handlers, schemas, sent } = setup(formPage());
  const nav = textOf(await handlers.get('navigate')({ url: 'http://localhost:8099/form.html' }));
  assert.ok(nav.includes('n1\t#nome') && nav.includes('n3\t#invia'), nav);

  // Lo schema accetta un campo con il solo ref (prima: selector obbligatorio).
  const parsed = schemas.get('fill_form').fields.safeParse([{ ref: 'n1', value: 'Mario Rossi' }]);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));

  await handlers.get('fill_form')({ fields: [{ ref: 'n1', value: 'Mario Rossi' }, { selector: '#email', value: 'm@example.com' }], submit_ref: 'n3' });
  const fill = sent.find((s) => s.type === 'fill_form');
  assert.deepEqual(fill.params.fields, [{ selector: '#nome', value: 'Mario Rossi' }, { selector: '#email', value: 'm@example.com' }]);
  assert.equal(fill.params.submit_selector, '#invia');
});

test('un ref sconosciuto in fill_form dà l\'errore parlante e non invia nulla', async () => {
  const { handlers, sent } = setup(formPage());
  await handlers.get('navigate')({ url: 'http://localhost:8099/form.html' });
  await assert.rejects(handlers.get('fill_form')({ fields: [{ ref: 'n99', value: 'x' }] }), /Unknown ref n99/);
  await assert.rejects(handlers.get('fill_form')({ fields: [{ value: 'x' }] }), /Either selector or ref is required/);
  assert.equal(sent.filter((s) => s.type === 'fill_form').length, 0);
});

test('dopo l\'invio after_submit riporta url, titolo e solo il testo nuovo', async () => {
  const { handlers } = setup(formPage());
  const out = JSON.parse(textOf(await handlers.get('fill_form')({ fields: [{ selector: '#nome', value: 'Mario Rossi' }], submit_selector: '#invia' })));
  assert.deepEqual(out.after_submit, {
    url: 'http://localhost:8099/form.html',
    title: 'Registrazione',
    new_text: 'Registrazione completata\nRegistrato: Mario Rossi',
  });
});

test('un invio che non cambia la pagina lo dice, dopo un\'attesa limitata', async () => {
  const { handlers } = setup(formPage({ afterSubmit: FORM_TEXT }));
  const t0 = Date.now();
  const out = JSON.parse(textOf(await handlers.get('fill_form')({ fields: [{ selector: '#nome', value: 'x' }], submit_selector: '#invia' })));
  assert.equal(out.after_submit.new_text, null);
  assert.equal(out.after_submit.note, 'page text unchanged after submit');
  assert.ok(Date.now() - t0 < 4000);
});

test('senza invio fill_form non legge la pagina e non aggiunge after_submit', async () => {
  const { handlers, sent } = setup(formPage());
  const out = JSON.parse(textOf(await handlers.get('fill_form')({ fields: [{ selector: '#nome', value: 'x' }] })));
  assert.equal(out.after_submit, undefined);
  assert.equal(sent.filter((s) => s.type === 'read_page').length, 0);
});

test('checked al posto di value per checkbox e radio, anche con i ref', async () => {
  const { handlers, schemas, sent } = setup(formPage());
  await handlers.get('navigate')({ url: 'http://localhost:8099/form.html' });
  const parsed = schemas.get('fill_form').fields.safeParse([{ ref: 'n1', checked: true }]);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  await handlers.get('fill_form')({ fields: [{ ref: 'n1', checked: true }, { selector: '#email', checked: false }, { selector: '#nome', value: 'x' }] });
  const fill = sent.find((s) => s.type === 'fill_form');
  assert.deepEqual(fill.params.fields, [
    { selector: '#nome', value: 'true' },
    { selector: '#email', value: 'false' },
    { selector: '#nome', value: 'x' },
  ]);
});

test('un campo senza value né checked dà un errore che lo nomina e non invia nulla', async () => {
  const { handlers, sent } = setup(formPage());
  await assert.rejects(handlers.get('fill_form')({ fields: [{ selector: '#privacy' }] }), /field #privacy needs value or checked/);
  assert.equal(sent.filter((s) => s.type === 'fill_form').length, 0);
});
