import { test } from 'node:test';
import assert from 'node:assert/strict';

const { registerTools } = await import('../../server/tools.js');

function setup(canned = {}) {
  const handlers = new Map();
  const fakeServer = { tool(name, _d, _s, handler) { handlers.set(name, handler); } };
  const fakeWs = {
    isConnected: () => true, mode: 'primary', port: 8765,
    sendCommand: async (type, params) => {
      if (typeof canned[type] === 'function') return canned[type](params);
      if (!(type in canned)) throw new Error(`No canned response for ${type}`);
      return canned[type];
    },
  };
  registerTools(fakeServer, fakeWs);
  return handlers;
}

const textOf = (r) => r.content.find((c) => c.type === 'text')?.text;

// Tabella catalogo: 1500 righe con oggetti {SKU, Nome, Categoria, Prezzo, Stock}
function bigCatalog(n = 1500) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      SKU: `SKU-${String(i).padStart(4, '0')}`,
      Nome: `Prodotto ${i}`,
      Categoria: ['Casa', 'Sport', 'Tech'][i % 3],
      Prezzo: `${100 + i}.0`,
      Stock: String(i % 5),
    });
  }
  return rows;
}

const CANNED = ({ scan_rows = 2000 }) => {
  const all = bigCatalog(1500);
  return {
    caption: null,
    headers: ['SKU', 'Nome', 'Categoria', 'Prezzo', 'Stock'],
    row_count: all.length,
    rows: all.slice(0, scan_rows),
    truncated: all.length > scan_rows,
    tables_found: 1,
  };
};

test('extract_table where: ritorna solo la riga che matcha, row_count resta totale', async () => {
  const handlers = setup({ extract_table: CANNED });
  const out = JSON.parse(textOf(await handlers.get('extract_table')({
    where: { SKU: 'SKU-0777' },
  })));
  assert.equal(out.row_count, 1500, 'conteggio totale preservato');
  assert.equal(out.match_count, 1, 'un solo match');
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].SKU, 'SKU-0777');
  assert.equal(out.rows[0].Categoria, 'Casa');
});

test('extract_table where: match case-insensitive e substring', async () => {
  const handlers = setup({ extract_table: CANNED });
  const out = JSON.parse(textOf(await handlers.get('extract_table')({
    where: { Categoria: 'sport' },
    max_rows: 5,
  })));
  assert.equal(out.match_count, 500, 'tutte le righe Sport contate');
  assert.equal(out.rows.length, 5, 'output capato a max_rows');
  assert.ok(out.truncated, 'flag troncamento su match');
  assert.ok(out.rows.every((r) => r.Categoria === 'Sport'));
});

test('extract_table columns: proietta solo le colonne richieste', async () => {
  const handlers = setup({ extract_table: CANNED });
  const out = JSON.parse(textOf(await handlers.get('extract_table')({
    where: { SKU: 'SKU-0777' },
    columns: ['Nome', 'Prezzo'],
  })));
  assert.deepEqual(Object.keys(out.rows[0]), ['Nome', 'Prezzo']);
});

test('extract_table offset: pagina il set filtrato', async () => {
  const handlers = setup({ extract_table: CANNED });
  const out = JSON.parse(textOf(await handlers.get('extract_table')({
    where: { Categoria: 'Casa' },
    offset: 2,
    max_rows: 3,
  })));
  assert.equal(out.match_count, 500);
  assert.equal(out.offset, 2);
  assert.equal(out.rows.length, 3);
  // Casa = indici 0,3,6,9,12... offset 2 => terza Casa = indice 6 => SKU-0006
  assert.equal(out.rows[0].SKU, 'SKU-0006');
});

test('extract_table senza where: comportamento invariato, cap a max_rows', async () => {
  const handlers = setup({ extract_table: CANNED });
  const out = JSON.parse(textOf(await handlers.get('extract_table')({
    max_rows: 10,
  })));
  assert.equal(out.row_count, 1500);
  assert.equal(out.rows.length, 10);
  assert.ok(out.truncated);
});

test('extract_table where su righe-array (headers non usabili): match any-cell', async () => {
  const handlers = setup({
    extract_table: {
      caption: null, headers: [], row_count: 3,
      rows: [['a', 'x'], ['b', 'SKU-0777'], ['c', 'z']],
      truncated: false, tables_found: 1,
    },
  });
  const out = JSON.parse(textOf(await handlers.get('extract_table')({
    where: { any: 'SKU-0777' },
  })));
  assert.equal(out.match_count, 1);
  assert.deepEqual(out.rows[0], ['b', 'SKU-0777']);
});
