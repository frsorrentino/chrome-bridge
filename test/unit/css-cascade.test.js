/**
 * cssStylesOf ricostruisce dal CSSOM quello che il pannello Styles di DevTools
 * mostra: per ogni proprietà chi vince e chi è stato battuto. Senza
 * chrome.debugger non c'è CSS.getMatchedStylesForNode, quindi l'ordine della
 * cascata è nostro e va inchiodato qui: !important, stile inline, @layer,
 * specificità, ordine nel sorgente.
 *
 * CSSOM finto: le classi portano il nome delle vere (la libreria distingue le
 * regole dal costruttore) e `matches` è un confronto di stringhe, così il test
 * prova la cascata e non il motore dei selettori.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/lib/css-cascade.js';

const cssStylesOf = globalThis.__cbCssStyles;
const specificity = globalThis.__cbCssSpecificity;

// --- CSSOM finto ---

function fakeStyle(decls) {
  const style = { length: decls.length };
  decls.forEach(([p], i) => { style[i] = p; });
  style.getPropertyValue = (p) => decls.find(([q]) => q === p)?.[1] ?? '';
  style.getPropertyPriority = (p) => (decls.find(([q]) => q === p)?.[2] ? 'important' : '');
  return style;
}
class CSSStyleRule { constructor(selectorText, decls, cssRules = []) { this.selectorText = selectorText; this.style = fakeStyle(decls); this.cssRules = cssRules; } }
class CSSNestedDeclarations { constructor(decls) { this.style = fakeStyle(decls); } }
class CSSMediaRule { constructor(conditionText, cssRules) { this.conditionText = conditionText; this.media = { mediaText: conditionText }; this.cssRules = cssRules; } }
class CSSSupportsRule { constructor(conditionText, cssRules) { this.conditionText = conditionText; this.cssRules = cssRules; } }
class CSSContainerRule { constructor(conditionText, cssRules) { this.conditionText = conditionText; this.cssRules = cssRules; } }
class CSSLayerBlockRule { constructor(name, cssRules) { this.name = name; this.cssRules = cssRules; } }
class CSSLayerStatementRule { constructor(nameList) { this.nameList = nameList; } }
class CSSKeyframesRule { constructor(name) { this.name = name; this.cssRules = [new CSSStyleRule('from', [['opacity', '0']])]; } }
class CSSImportRule { constructor(styleSheet, href, { layerName = null, media = '' } = {}) { this.styleSheet = styleSheet; this.href = href; this.layerName = layerName; this.media = { mediaText: media }; } }

const sheet = (rules, { href = null, ownerNode = null } = {}) => ({ href, cssRules: rules, ownerNode });
const opaqueSheet = (href) => ({ href, get cssRules() { throw Object.assign(new Error('Cannot access rules'), { name: 'SecurityError' }); } });

function el({ tag = 'div', id = '', classes = [], matches = [], style = [], parent = null, root }) {
  const set = new Set(matches);
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id,
    className: classes.join(' '),
    style: fakeStyle(style),
    parentNode: parent,
    parentElement: parent,
    matches: (sel) => sel.split(',').some((s) => set.has(s.trim())),
    getRootNode: () => root,
  };
  return node;
}

function env({ computed = {}, media = () => false, supports = () => true } = {}) {
  return {
    styleSheetsOf: (root) => root.sheets,
    getComputedStyle: () => ({ getPropertyValue: (p) => computed[p] ?? '' }),
    matchMedia: media,
    supports,
  };
}

const root = (...sheets) => ({ sheets });
const run = (element, opts = {}, e = env()) => cssStylesOf(element, opts, e);

// --- cascata ---

test('a parità di specificità vince la regola più in basso; la battuta finisce in overridden con foglio e posizione', () => {
  const r = root(sheet([
    new CSSStyleRule('p', [['margin-top', '1rem']]),
    new CSSStyleRule('p', [['margin-top', '0px']]),
  ], { href: 'https://cdn.example.com/css/main.css?v=3' }));
  const out = run(el({ tag: 'p', matches: ['p'], root: r }), {}, env({ computed: { 'margin-top': '0px' } }));
  const mt = out.properties['margin-top'];
  assert.equal(mt.value, '0px');
  assert.equal(mt.computed, '0px');
  assert.deepEqual(mt.source, { selector: 'p', sheet: 'main.css', rule: 1 });
  assert.deepEqual(mt.overridden, [{ value: '1rem', selector: 'p', sheet: 'main.css', rule: 0 }]);
  assert.equal(out.matched_rules, 2);
  assert.deepEqual(out.stylesheets, [{ sheet: 'main.css', href: 'https://cdn.example.com/css/main.css?v=3', rules: 2 }]);
});

test('la specificità batte l\'ordine; di una lista di selettori conta quello che combacia', () => {
  const r = root(sheet([
    new CSSStyleRule('.title, #hero h1', [['color', 'red']]),
    new CSSStyleRule('h1', [['color', 'blue']]),
  ], { ownerNode: {} }));
  const out = run(el({ tag: 'h1', matches: ['h1', '#hero h1'], root: r }));
  assert.equal(out.properties.color.value, 'red');
  assert.equal(out.properties.color.source.selector, '#hero h1');
  assert.equal(out.properties.color.source.sheet, '<style> #1');
});

test('!important batte specificità e stile inline; lo stile inline batte ogni regola normale', () => {
  const r = root(sheet([
    new CSSStyleRule('#x', [['display', 'grid']]),
    new CSSStyleRule('div', [['display', 'none', true]]),
    new CSSStyleRule('.card', [['width', '10px']]),
  ]));
  const out = run(el({ tag: 'div', id: 'x', classes: ['card'], matches: ['#x', 'div', '.card'], style: [['display', 'flex'], ['width', '20px']], root: r }));
  assert.equal(out.properties.display.value, 'none');
  assert.equal(out.properties.display.important, true);
  assert.deepEqual(out.properties.display.overridden.map((o) => o.value), ['flex', 'grid']);
  assert.deepEqual(out.properties.display.overridden[0], { value: 'flex', inline: true });
  assert.equal(out.properties.width.value, '20px');
  assert.deepEqual(out.properties.width.source, { inline: true });
});

test('@media: la regola che non combacia è ignorata, quella che combacia porta la condizione', () => {
  const r = root(sheet([
    new CSSStyleRule('div', [['width', '600px']]),
    new CSSMediaRule('(max-width: 700px)', [new CSSStyleRule('div', [['width', 'auto']])]),
    new CSSMediaRule('(min-width: 700px)', [new CSSStyleRule('div', [['padding-top', '2px']])]),
    new CSSSupportsRule('(display: grid)', [new CSSStyleRule('div', [['gap', '1px']])]),
    new CSSSupportsRule('(display: nope)', [new CSSStyleRule('div', [['gap', '9px']])]),
  ]));
  const e = env({ media: (q) => q === '(min-width: 700px)', supports: (c) => !c.includes('nope') });
  const out = run(el({ tag: 'div', matches: ['div'], root: r }), {}, e);
  assert.equal(out.properties.width.value, '600px');
  assert.equal(out.properties.width.overridden.length, 0);
  assert.deepEqual(out.properties['padding-top'].source.conditions, ['@media (min-width: 700px)']);
  assert.equal(out.properties.gap.value, '1px');
});

test('@layer: senza layer batte i layer; tra layer vince l\'ultimo dichiarato; con !important l\'ordine si inverte', () => {
  const r = root(sheet([
    new CSSLayerStatementRule(['base', 'theme']),
    new CSSLayerBlockRule('theme', [new CSSStyleRule('p', [['color', 'theme'], ['margin-top', '2px', true]])]),
    new CSSLayerBlockRule('base', [new CSSStyleRule('p.x', [['color', 'base'], ['margin-top', '1px', true]])]),
    new CSSStyleRule('p', [['color', 'plain'], ['margin-top', '3px', true]]),
  ]));
  const out = run(el({ tag: 'p', matches: ['p', 'p.x'], root: r }));
  assert.equal(out.properties.color.value, 'plain', 'senza layer vince anche con specificità più bassa');
  assert.deepEqual(out.properties.color.overridden.map((o) => `${o.value}@${o.layer}`), ['theme@theme', 'base@base']);
  assert.equal(out.properties['margin-top'].value, '1px', 'important: il primo layer dichiarato vince, senza layer perde');
  assert.deepEqual(out.properties['margin-top'].overridden.map((o) => o.value), ['2px', '3px']);
});

test('@import porta il proprio foglio, il layer del layer() e ignora le regole fuori media; un foglio cross-origin è opaco', () => {
  const imported = sheet([new CSSStyleRule('p', [['color', 'imported']])], { href: 'https://cdn.example.com/theme.css' });
  const printOnly = sheet([new CSSStyleRule('p', [['color', 'print']])], { href: 'https://cdn.example.com/print.css' });
  const r = root(sheet([
    new CSSImportRule(imported, 'https://cdn.example.com/theme.css', { layerName: 'vendor' }),
    new CSSImportRule(printOnly, 'https://cdn.example.com/print.css', { media: 'print' }),
    new CSSImportRule(null, 'https://other.example.org/blocked.css'),
    new CSSStyleRule('p', [['color', 'own']]),
  ], { href: 'https://cdn.example.com/main.css' }), opaqueSheet('https://fonts.example.org/f.css'));
  const out = run(el({ tag: 'p', matches: ['p'], root: r }), {}, env({ media: (q) => q === 'screen' }));
  assert.equal(out.properties.color.value, 'own');
  assert.deepEqual(out.properties.color.overridden, [{ value: 'imported', selector: 'p', sheet: 'theme.css', rule: 0, layer: 'vendor' }]);
  assert.deepEqual(out.opaque_stylesheets, ['https://other.example.org/blocked.css', 'https://fonts.example.org/f.css']);
});

test('@container e @scope non si valutano: contati in skipped, mai spacciati per vincitori; @keyframes ignorato', () => {
  const r = root(sheet([
    new CSSStyleRule('p', [['opacity', '1']]),
    new CSSContainerRule('(min-width: 400px)', [new CSSStyleRule('p', [['opacity', '0.5']]), new CSSStyleRule('p', [['color', 'red']])]),
    new CSSKeyframesRule('fade'),
  ]));
  const out = run(el({ tag: 'p', matches: ['p', 'from'], root: r }));
  assert.equal(out.properties.opacity.value, '1');
  assert.deepEqual(out.skipped, [{ condition: '@container (min-width: 400px)', rules: 2 }]);
  assert.equal(out.properties.color, undefined);
});

test('regole annidate: & e i selettori relativi si risolvono contro il padre, con la sua specificità', () => {
  const r = root(sheet([
    new CSSStyleRule('.card', [['padding-top', '4px']], [
      new CSSStyleRule('&.active', [['padding-top', '8px']]),
      new CSSStyleRule('.title', [['font-weight', '700']]),
      new CSSNestedDeclarations([['padding-top', '6px']]),
    ]),
  ]));
  const card = el({ tag: 'div', classes: ['card', 'active'], matches: ['.card', ':is(.card).active'], root: r });
  const out = run(card);
  assert.equal(out.properties['padding-top'].value, '8px', '&.active (0,2,0) batte le dichiarazioni annidate del padre (0,1,0)');
  assert.equal(out.properties['padding-top'].source.selector, ':is(.card).active');
  assert.deepEqual(out.properties['padding-top'].overridden.map((o) => o.value), ['6px', '4px']);
  const title = el({ tag: 'h2', classes: ['title'], matches: ['.title', ':is(.card) .title'], root: r });
  assert.equal(run(title).properties['font-weight'].source.selector, ':is(.card) .title');
});

test('properties filtra, e uno shorthand copre i suoi longhand; overridden è tagliato a 5', () => {
  const rules = [];
  for (let i = 0; i < 8; i++) rules.push(new CSSStyleRule('p', [['margin-top', `${i}px`], ['margin-left', `${i}px`], ['color', 'red'], ['--brand', `#${i}`]]));
  const r = root(sheet(rules));
  const out = run(el({ tag: 'p', matches: ['p'], root: r }), { properties: ['margin', '--brand'] });
  assert.deepEqual(Object.keys(out.properties), ['--brand', 'margin-left', 'margin-top']);
  assert.equal(out.properties['margin-top'].value, '7px');
  assert.equal(out.properties['margin-top'].overridden.length, 5);
  assert.equal(out.properties['margin-top'].overridden_more, 2);
});

test('include_inherited risale agli antenati per le proprietà ereditate, e solo per quelle che l\'elemento non dichiara', () => {
  const r = root(sheet([
    new CSSStyleRule('body', [['color', 'black'], ['font-family', 'serif'], ['width', '60vw']]),
    new CSSStyleRule('.card', [['color', 'gray']]),
    new CSSStyleRule('h1', [['font-size', '2em']]),
  ]));
  const body = el({ tag: 'body', matches: ['body'], root: r });
  const card = el({ tag: 'div', classes: ['card', 'x'], matches: ['.card'], parent: body, root: r });
  const h1 = el({ tag: 'h1', matches: ['h1'], parent: card, style: [['color', 'blue']], root: r });
  const e = env({ computed: { color: 'rgb(0, 0, 255)', 'font-family': 'serif' } });
  const plain = run(h1, {}, e);
  assert.deepEqual(Object.keys(plain.properties), ['color', 'font-size']);
  const out = run(h1, { include_inherited: true }, e);
  assert.equal(out.properties.color.value, 'blue', 'dichiarata sull\'elemento: non si eredita');
  assert.equal(out.properties['font-family'].value, 'serif');
  assert.equal(out.properties['font-family'].inherited_from, 'body');
  assert.equal(out.properties['font-family'].computed, 'serif');
  assert.equal(out.properties.width, undefined, 'width non si eredita');
  assert.equal(out.properties['font-size'].inherited_from, undefined);
});

test('elemento senza regole: mappa vuota, niente errori; stili inline soli', () => {
  const r = root(sheet([new CSSStyleRule('a', [['color', 'red']])]));
  const out = run(el({ tag: 'span', matches: [], style: [['color', 'green']], root: r }));
  assert.equal(out.matched_rules, 0);
  assert.deepEqual(out.properties.color.source, { inline: true });
  assert.equal(out.element, 'span');
  const none = run(el({ tag: 'span', id: 'k', classes: ['a', 'b', 'c'], matches: [], root: r }));
  assert.deepEqual(none.properties, {});
  assert.equal(none.element, 'span#k.a.b');
});

// --- specificità ---

test('specificità: i casi che decidono una cascata', () => {
  const cases = [
    ['*', [0, 0, 0]],
    ['li', [0, 0, 1]],
    ['ul ol+li', [0, 0, 3]],
    ['h1 + *[rel=up]', [0, 1, 1]],
    ['ul ol li.red', [0, 1, 3]],
    ['li.red.level', [0, 2, 1]],
    ['#x34y', [1, 0, 0]],
    ['#s12:not(foo)', [1, 0, 1]],
    ['.foo :is(.bar, #baz)', [1, 1, 0]],
    [':where(#a, .b)', [0, 0, 0]],
    [':not(.a .b)', [0, 2, 0]],
    [':nth-child(2n of .x, #y)', [1, 1, 0]],
    ['li:nth-child(2)', [0, 1, 1]],
    ['a[href^="x"]:hover::before', [0, 2, 2]],
    ['h1:before', [0, 0, 2]],
    [':host(.a) span', [0, 2, 1]],
    ['svg|circle', [0, 0, 1]],
    ['*|*', [0, 0, 0]],
    ['input[type="text"]', [0, 1, 1]],
    ['.a\\:b', [0, 1, 0]],
    ['a[title="x, y"]', [0, 1, 1]],
  ];
  for (const [sel, want] of cases) assert.deepEqual(specificity(sel), want, sel);
});
