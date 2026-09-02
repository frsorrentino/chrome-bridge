/**
 * Verifica batch dei redirect di una migrazione: una riga di CSV per ogni
 * URL vecchio → URL atteso, una http_request per riga (con i cookie del
 * browser, quindi anche dietro login), esito per riga. Pensato per la CLI a
 * zero token: il modello legge solo le righe che non tornano.
 */

/** CSV minimale: separatore virgola o punto e virgola, intestazione opzionale. */
export function parseRedirectCsv(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [a, b = ''] = line.split(/[;,]/).map((s) => s.trim().replace(/^"|"$/g, ''));
    if (/^(from|old|source|url)$/i.test(a)) continue; // intestazione
    rows.push({ from: a, expected: b || null });
  }
  return rows;
}

function normalize(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    let s = u.toString();
    if (u.pathname !== '/' && s.endsWith('/')) s = s.slice(0, -1);
    return s.replace(/^http:\/\//, 'https://');
  } catch { return String(url); }
}

/**
 * @param {(type:string, params:object)=>Promise<any>} sendCommand
 * @param {Array<{from:string, expected:string|null}>} rows
 */
export async function checkRedirects(sendCommand, rows, { concurrency = 4 } = {}) {
  const results = new Array(rows.length);
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const idx = i++;
      const row = rows[idx];
      try {
        const r = await sendCommand('http_request', { url: row.from, method: 'GET', max_length: 0 });
        const final = r?.url || row.from;
        let verdict;
        if (row.expected) verdict = normalize(final) === normalize(row.expected) ? 'ok' : 'mismatch';
        else verdict = r?.status >= 200 && r?.status < 400 ? 'ok' : 'error';
        results[idx] = { from: row.from, status: r?.status ?? null, final, expected: row.expected, verdict };
      } catch (err) {
        results[idx] = { from: row.from, status: null, final: null, expected: row.expected, verdict: 'error', error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return results;
}

export function redirectLines(results) {
  const bad = results.filter((r) => r.verdict !== 'ok');
  const lines = results.map((r) => [r.verdict, r.status ?? '-', r.from, r.final ?? '-', r.expected ? `expected ${r.expected}` : '', r.error ?? ''].filter((x) => x !== '').join('\t'));
  return `redirects total=${results.length} ok=${results.length - bad.length} mismatch=${results.filter((r) => r.verdict === 'mismatch').length} error=${results.filter((r) => r.verdict === 'error').length}\n${lines.join('\n')}`;
}
