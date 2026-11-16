#!/usr/bin/env node
/**
 * Riscrive le copie inline di deepQuery in extension/service-worker.js a
 * partire da extension/lib/deep-query.js, la fonte unica. Ogni copia sta tra
 * una riga «// deep-query:begin …» e una «// deep-query:end» con la stessa
 * rientranza; il contenuto è la fonte senza `export`, rientrato come i
 * marcatori.
 *
 *   node tools/sync-deep-query.mjs           riscrive service-worker.js
 *   node tools/sync-deep-query.mjs --check   esce 1 se una copia è diversa
 *
 * test/unit/deep-query.test.js usa syncDeepQuery per lo stesso controllo.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BEGIN = '// deep-query:begin';
const END = '// deep-query:end';
const NOTE = `${BEGIN} (generato da extension/lib/deep-query.js: node tools/sync-deep-query.mjs)`;

/** Il corpo tra i marcatori della fonte, senza `export`, a rientranza zero. */
export function sourceBody(source) {
  const lines = source.split('\n');
  const from = lines.findIndex((l) => l.trim() === BEGIN);
  const to = lines.findIndex((l) => l.trim() === END);
  if (from < 0 || to < from) throw new Error(`deep-query.js: marcatori ${BEGIN} / ${END} mancanti`);
  return lines.slice(from + 1, to).map((l) => l.replace(/^export /, ''));
}

/**
 * @returns {{ text: string, regions: number, stray: number[] }} il file con le
 *   copie rigenerate, quante regioni ha trovato, e le righe (1-based) di una
 *   function deepQuery/deepQueryAll fuori da ogni regione.
 */
export function syncDeepQuery(swText, source) {
  const body = sourceBody(source);
  const lines = swText.split('\n');
  const out = [];
  const stray = [];
  let regions = 0;
  for (let i = 0; i < lines.length; i++) {
    const begin = /^(\s*)\/\/ deep-query:begin\b/.exec(lines[i]);
    if (!begin) {
      if (/^\s*function deepQuery(All)?\(/.test(lines[i])) stray.push(i + 1);
      out.push(lines[i]);
      continue;
    }
    const indent = begin[1];
    let end = i + 1;
    while (end < lines.length && lines[end] !== `${indent}${END}`) end++;
    if (end === lines.length) throw new Error(`service-worker.js:${i + 1}: ${BEGIN} senza ${END}`);
    out.push(`${indent}${NOTE}`, ...body.map((l) => (l ? indent + l : l)), `${indent}${END}`);
    regions++;
    i = end;
  }
  return { text: out.join('\n'), regions, stray };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const swPath = new URL('../extension/service-worker.js', import.meta.url);
  const srcPath = new URL('../extension/lib/deep-query.js', import.meta.url);
  const sw = readFileSync(swPath, 'utf8');
  const r = syncDeepQuery(sw, readFileSync(srcPath, 'utf8'));
  if (r.stray.length) {
    console.error(`deepQuery fuori dai marcatori in service-worker.js, righe ${r.stray.join(', ')}`);
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    if (r.text !== sw) { console.error('copie inline di deepQuery diverse dalla fonte: node tools/sync-deep-query.mjs'); process.exit(1); }
    console.log(`${r.regions} copie allineate`);
  } else {
    if (r.text !== sw) writeFileSync(swPath, r.text);
    console.log(`${r.regions} copie ${r.text === sw ? 'già allineate' : 'riscritte'}`);
  }
}
