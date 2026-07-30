/**
 * read_page(mode='markdown'): struttura preservata a una frazione del costo di
 * html. Tre difetti ricorrenti nei renderer DOM→markdown, qui fissati come test:
 *
 * 1. selettore piatto che include sia `a` sia `li`, quindi `<li><a>x</a></li>`
 *    esce due volte (una come voce di lista, una come link);
 * 2. tabelle troncate a 10 righe × 3 colonne con un'intestazione finta
 *    "| Table Content |" che butta via gli header veri;
 * 3. taglio secco a 50.000 caratteri senza dichiararlo.
 *
 * La funzione gira nella pagina, quindi qui è testata contro un DOM finto: è
 * pura, prende un `document` e restituisce una stringa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'node-html-parser';
import { buildMarkdown } from '../../extension/lib/page-markdown.js';

function fakeDoc(html, { title = 'T' } = {}) {
  // Basta un albero con tagName/childNodes/textContent per esercitare il
  // walker, senza trascinare jsdom fra le dipendenze.
  const root = parse(html);
  const adapt = (node) => {
    if (node.nodeType === 3) return { nodeType: 3, textContent: node.rawText };
    return {
      nodeType: 1,
      tagName: (node.rawTagName || '').toUpperCase(),
      childNodes: node.childNodes.map(adapt),
      textContent: node.textContent,
      getAttribute: (n) => node.getAttribute(n) ?? null,
      querySelector: (sel) => { const f = node.querySelector(sel); return f ? adapt(f) : null; },
      querySelectorAll: (sel) => node.querySelectorAll(sel).map(adapt),
    };
  };
  return { title, body: adapt(root) };
}

test('una voce di lista con un link esce una volta sola', () => {
  const md = buildMarkdown(fakeDoc('<ul><li><a href="/x">Contatti</a></li></ul>'));
  const occurrences = (md.match(/Contatti/g) || []).length;
  assert.equal(occurrences, 1, `"Contatti" appare ${occurrences} volte:\n${md}`);
  assert.match(md, /\/x/, 'l\'href della voce di lista è andato perso');
});

test('gli heading diventano heading, non testo piatto', () => {
  const md = buildMarkdown(fakeDoc('<h2>Sezione</h2><p>Corpo</p>'));
  assert.match(md, /^## Sezione$/m);
  assert.match(md, /^Corpo$/m);
});

test('una tabella conserva le intestazioni vere', () => {
  const md = buildMarkdown(fakeDoc(
    '<table><thead><tr><th>Nome</th><th>Prezzo</th></tr></thead>'
    + '<tbody><tr><td>Vite</td><td>2</td></tr></tbody></table>',
  ));
  assert.match(md, /\|\s*Nome\s*\|\s*Prezzo\s*\|/, 'gli header veri sono stati sostituiti da un segnaposto');
  assert.match(md, /\|\s*Vite\s*\|\s*2\s*\|/);
  assert.doesNotMatch(md, /Table Content/);
});

test('una tabella lunga dichiara quante righe ha omesso e indica lo strumento giusto', () => {
  const rows = Array.from({ length: 120 }, (_, i) => `<tr><td>r${i}</td><td>${i}</td></tr>`).join('');
  const md = buildMarkdown(fakeDoc(`<table><tr><th>a</th><th>b</th></tr>${rows}</table>`));
  assert.match(md, /120 rows/i, 'il totale delle righe non è dichiarato');
  assert.match(md, /extract_table/, 'senza il rimando, l\'agente non sa come ottenere le righe che gli servono');
});

test('le icone non finiscono nel markdown, le immagini vere sì', () => {
  const md = buildMarkdown(fakeDoc(
    '<img src="/icon.png" alt="i" width="16" height="16">'
    + '<img src="/hero.jpg" alt="Prodotto" width="800" height="600">',
  ));
  assert.doesNotMatch(md, /icon\.png/, 'un\'icona 16x16 non merita una riga di contesto');
  assert.match(md, /hero\.jpg/);
  assert.match(md, /Prodotto/);
});

test('script e style non entrano nel testo', () => {
  const md = buildMarkdown(fakeDoc('<p>Visibile</p><script>var x=1</script><style>.a{color:red}</style>'));
  assert.match(md, /Visibile/);
  assert.doesNotMatch(md, /var x=1/);
  assert.doesNotMatch(md, /color:red/);
});
