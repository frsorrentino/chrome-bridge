/**
 * Geometria dell'affiancamento. È la parte che vale la pena testare: il resto
 * del tool è una sequenza di chiamate a chrome.windows.update.
 *
 * Il bug classico è il resto della divisione intera: 3 finestre su 1000px danno
 * 333 ciascuna e un pixel avanza. Se lo si butta, resta una striscia di
 * scrivania scoperta; se lo si somma all'ultima, le finestre non sono più uguali
 * ma almeno lo spazio è pieno. La richiesta era "occupare in parti uguali
 * l'intero spazio", e le due cose sono in tensione: qui si sceglie di riempire,
 * distribuendo il resto un pixel per volta invece che tutto in fondo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTiles } from '../../extension/lib/tile-layout.js';

const AREA = { left: 0, top: 0, width: 1000, height: 800 };

const covers = (tiles, area) => {
  const px = tiles.reduce((a, t) => a + t.width * t.height, 0);
  return px === area.width * area.height;
};

const overlaps = (tiles) => tiles.some((a, i) => tiles.some((b, j) => j > i
  && a.left < b.left + b.width && b.left < a.left + a.width
  && a.top < b.top + b.height && b.top < a.top + a.height));

test('due finestre dividono lo schermo in due colonne senza lasciare pixel scoperti', () => {
  const tiles = computeTiles({ count: 2, area: AREA, layout: 'columns' });
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0].width + tiles[1].width, AREA.width);
  assert.equal(tiles[0].height, AREA.height);
  assert.ok(covers(tiles, AREA), 'lo spazio non è coperto per intero');
  assert.ok(!overlaps(tiles), 'le finestre si sovrappongono');
});

test('con un resto dispari lo spazio resta pieno e la differenza è di un pixel', () => {
  const tiles = computeTiles({ count: 3, area: AREA, layout: 'columns' });
  assert.equal(tiles.reduce((a, t) => a + t.width, 0), AREA.width, 'un pixel è andato perso');
  const widths = tiles.map((t) => t.width);
  assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, `larghezze troppo diverse: ${widths}`);
  assert.ok(!overlaps(tiles));
});

test('le tessere partono dall\'origine dell\'area, non da zero dello schermo virtuale', () => {
  // Su più monitor l'area utile del secondo schermo ha left/top diversi da zero:
  // ignorarli piazzerebbe tutto sul monitor principale.
  const area = { left: 1920, top: 40, width: 1000, height: 800 };
  const tiles = computeTiles({ count: 2, area, layout: 'columns' });
  assert.equal(tiles[0].left, 1920);
  assert.equal(tiles[0].top, 40);
  assert.equal(tiles[1].left, 1920 + tiles[0].width);
});

test('quattro finestre in griglia fanno due per due e riempiono tutto', () => {
  const tiles = computeTiles({ count: 4, area: AREA, layout: 'grid' });
  assert.equal(tiles.length, 4);
  assert.ok(covers(tiles, AREA));
  assert.ok(!overlaps(tiles));
  assert.equal(new Set(tiles.map((t) => t.left)).size, 2, 'non sono due colonne');
  assert.equal(new Set(tiles.map((t) => t.top)).size, 2, 'non sono due righe');
});

test('cinque finestre in griglia non lasciano buchi né sovrapposizioni', () => {
  const tiles = computeTiles({ count: 5, area: AREA, layout: 'grid' });
  assert.equal(tiles.length, 5);
  assert.ok(!overlaps(tiles), 'le finestre si sovrappongono');
  // L'ultima riga è incompleta: le sue tessere si allargano per riempirla.
  assert.ok(covers(tiles, AREA), 'restano pixel scoperti');
});

test('una sola finestra occupa tutto', () => {
  const [t] = computeTiles({ count: 1, area: AREA, layout: 'grid' });
  assert.deepEqual(t, { left: 0, top: 0, width: 1000, height: 800 });
});

test('il padding si toglie dallo spazio, non lo sfora', () => {
  const tiles = computeTiles({ count: 2, area: AREA, layout: 'columns', padding: 10 });
  assert.ok(tiles[0].left >= AREA.left + 10);
  const right = Math.max(...tiles.map((t) => t.left + t.width));
  assert.ok(right <= AREA.left + AREA.width - 10, 'le finestre escono dall\'area utile');
});

test('zero finestre non produce tessere', () => {
  assert.deepEqual(computeTiles({ count: 0, area: AREA }), []);
});
