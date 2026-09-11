/**
 * Statistiche e report per bench/latency.mjs. Pura: niente Chrome, niente
 * filesystem, così test/unit/latency-stats.test.js la esercita da sola.
 *
 * p95 nearest-rank: il campione di rango ceil(0.95·n). Con 5 giri coincide
 * col massimo, e il report lo dice invece di fingere una distribuzione.
 */

export function summarize(samples) {
  const n = samples.length;
  if (!n) return { n: 0, min: null, median: null, p95: null, max: null };
  const s = [...samples].sort((a, b) => a - b);
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const p95 = s[Math.max(0, Math.ceil(0.95 * n) - 1)];
  return { n, min: s[0], median, p95, max: s[n - 1] };
}

const ms = (v) => (v == null ? '—' : String(Math.round(v)));

export function renderReport({ date, env = {}, rounds, cold_start_ms, threshold_ms = null, rows = [], pages = 'bench/form.html, bench/heavy.html' }) {
  const lines = [];
  lines.push('# Latency per tool');
  lines.push('');
  lines.push(`Measured ${date} on the real path: stdio MCP client → server → WebSocket → extension → page, `
    + `${rounds} rounds per tool (medians), local pages (${pages}), headless launch mode. `
    + `Environment: Node ${env.node ?? '?'}, Chrome ${env.chrome ?? '?'}, extension ${env.extension ?? '?'}, `
    + `server ${env.server ?? '?'}, ${env.platform ?? '?'}. Nothing here is estimated: `
    + 'every number came out of `npm run bench:latency`.');
  lines.push('');
  lines.push(`Cold start, spawn → extension connected: ${ms(cold_start_ms)} ms.`);
  lines.push('');
  lines.push('| Tool | min | median | p95 | max | Note |');
  lines.push('|---|---:|---:|---:|---:|---|');
  for (const r of rows) {
    const slow = threshold_ms != null && r.median != null && r.median > threshold_ms;
    lines.push(`| \`${r.tool}\`${slow ? ' ⚠' : ''} | ${ms(r.min)} | ${ms(r.median)} | ${ms(r.p95)} | ${ms(r.max)} | ${r.note ?? ''} |`);
  }
  lines.push('');
  lines.push(`Milliseconds, rounded. p95 is nearest-rank (the sample of rank ceil(0.95·n)): with ${rounds} rounds it is the maximum. `
    + (threshold_ms != null
      ? `⚠ marks a median above ${threshold_ms} ms, the budget declared for a tool on a static local page: `
        + 'a call that sits on a timeout is a bug of this class, not a slow page.'
      : 'No budget declared for this run.'));
  lines.push('');
  return lines.join('\n');
}
