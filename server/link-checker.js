/**
 * Verifica HTTP dei link lato server (niente limiti CORS della pagina).
 * HEAD con fallback GET per server che non supportano HEAD.
 */

async function checkOne({ url, text }, timeoutMs) {
  let lastError = null;
  for (const method of ['HEAD', 'GET']) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { method, redirect: 'follow', signal: ctrl.signal });
      clearTimeout(timer);
      if (method === 'HEAD' && (resp.status === 405 || resp.status === 501)) continue;
      return { url, text, status: resp.status, ok: resp.ok, broken: resp.status >= 400 };
    } catch (err) {
      clearTimeout(timer);
      lastError = err.cause?.message || err.message || 'Network error';
    }
  }
  return { url, text, status: 0, ok: false, broken: true, error: lastError };
}

export async function checkLinksBatch(links, timeoutMs = 5000, concurrency = 10) {
  const results = new Array(links.length);
  let next = 0;
  async function worker() {
    while (next < links.length) {
      const idx = next++;
      results[idx] = await checkOne(links[idx], timeoutMs);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, links.length) }, worker);
  await Promise.all(workers);
  return results;
}
