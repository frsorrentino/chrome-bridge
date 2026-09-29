import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from '../../server/cli.js';

// Client finto: risponde ai comandi dell'estensione come farebbe il relay.
function fakeClient() {
  const sent = [];
  const replies = {
    navigate: { url: 'https://shop.test/', title: 'Shop', tabId: 5 },
    get_interactives: { elements: [{ selector: '#add', label: 'Add to cart' }] },
    page_fingerprint: { url: 'https://shop.test/', title: 'Shop', nodes: 10 },
    click: { clicked: true },
    extract_table: { headers: ['sku', 'price'], row_count: 3, rows: [{ sku: 'A', price: '1' }, { sku: 'B', price: '2' }, { sku: 'C', price: '3' }] },
  };
  return {
    sent,
    sendCommand: async (type, params) => { sent.push({ type, params }); if (!(type in replies)) throw new Error(`no reply for ${type}`); return replies[type]; },
  };
}

test('run: lo script chiama i tool veri, con cicli, ref e filtri lato server, e restituisce solo il risultato', async () => {
  const client = fakeClient();
  const code = `
    const page = await cb.navigate({ url: 'https://shop.test/' });
    await cb.get_interactives({});
    for (let i = 0; i < 3; i++) await cb.click({ ref: 'n1' });
    const t = await cb.extract_table({ where: { sku: 'B' } });
    log('rows', t.match_count);
    return { title: page, price: t.rows[0].price };
  `;
  const out = await runScript(client, code);
  assert.equal(out.result.price, '2', 'where applicato come nel tool MCP');
  assert.equal(client.sent.filter((s) => s.type === 'click').length, 3);
  assert.ok(client.sent.filter((s) => s.type === 'click').every((s) => s.params.selector === '#add'), 'ref risolto');
  assert.deepEqual(out.log, ['rows 1']);
});

test('run: un tool sconosciuto o parametri sbagliati danno un errore chiaro', async () => {
  await assert.rejects(runScript(fakeClient(), 'await cb.nope({})'), /unknown tool nope/);
  await assert.rejects(runScript(fakeClient(), 'await cb.navigate({})'), /url/);
});
