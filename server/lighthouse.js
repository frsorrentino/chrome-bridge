/**
 * lighthouse: il CLI di Lighthouse contro la porta CDP del browser lanciato,
 * prestazioni comprese (chrome-devtools-mcp le esclude dal suo audit). Il
 * report intero va su file; al modello arrivano punteggi, metriche e le voci
 * che pesano di più fra quelle non superate.
 *
 * Il CLI arriva con npx alla prima chiamata (versione fissata, ~19 MB): non è
 * una dipendenza di chrome-bridge. Lighthouse 13 vuole Node >= 22.19, mentre
 * chrome-bridge gira da Node 18: sotto si usa la 12.8.2 (Node >= 18.16).
 */
import { spawn } from 'node:child_process';

export function lighthouseVersion(node = process.versions.node) {
  const [maj, min] = node.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 19) ? '13.5.0' : '12.8.2';
}
const METRICS = ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index'];

export function lighthouseArgs(url, port, outBase, { categories, formFactor = 'mobile' } = {}) {
  return ['-y', `lighthouse@${lighthouseVersion()}`, url, `--port=${port}`, '--output=json', '--output=html', `--output-path=${outBase}`,
    '--quiet', ...(categories?.length ? [`--only-categories=${categories.join(',')}`] : []), ...(formFactor === 'desktop' ? ['--preset=desktop'] : [])];
}

export function runLighthouse(args, { timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.CHROME_BRIDGE_NPX || 'npx', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`Lighthouse did not finish within ${timeoutMs / 1000} s`)); }, timeoutMs);
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'npx not found: Lighthouse runs through npx (Node.js)' : e.message)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Lighthouse exited with ${code}: ${err.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`));
    });
  });
}

/** Sintesi del report JSON: punteggi 0-100, metriche, voci non superate per peso. */
export function summarizeLighthouse(lhr, { top = 10 } = {}) {
  const categories = {};
  const failing = [];
  for (const [id, cat] of Object.entries(lhr.categories ?? {})) {
    categories[id] = cat.score == null ? null : Math.round(cat.score * 100);
    for (const ref of cat.auditRefs ?? []) {
      const a = lhr.audits?.[ref.id];
      if (!a || a.score == null || a.score >= 0.9 || a.scoreDisplayMode === 'informative' || a.scoreDisplayMode === 'notApplicable') continue;
      if (!ref.weight && !a.metricSavings) continue;
      failing.push({
        category: id, id: ref.id, title: a.title, score: Math.round(a.score * 100),
        ...(a.displayValue && { value: a.displayValue }),
        ...(a.metricSavings && Object.values(a.metricSavings).some(Boolean) && { savings: a.metricSavings }),
        weight: ref.weight ?? 0,
      });
    }
  }
  failing.sort((x, y) => (y.weight - x.weight) || (x.score - y.score));
  const metrics = {};
  for (const m of METRICS) {
    const a = lhr.audits?.[m];
    if (a) metrics[m] = { value: a.displayValue ?? null, score: a.score == null ? null : Math.round(a.score * 100) };
  }
  return {
    url: lhr.finalDisplayedUrl ?? lhr.finalUrl ?? lhr.requestedUrl,
    lighthouse: lhr.lighthouseVersion,
    form_factor: lhr.configSettings?.formFactor ?? null,
    categories,
    metrics,
    failing: failing.slice(0, top).map(({ weight: _w, ...r }) => r),
    ...(lhr.runWarnings?.length && { warnings: lhr.runWarnings.slice(0, 3) }),
  };
}
