/**
 * Verifica HTTP dei link lato server (niente limiti CORS della pagina).
 * HEAD con fallback GET per server che non supportano HEAD.
 *
 * Nota SSRF: i link arrivano dalla pagina aperta dall'utente (tool locale di
 * sviluppo); nessun filtro su IP privati. Solo http/https.
 *
 * Nota: HEAD 403 da bot-protection può causare falsi positivi; il fallback
 * GET scatta solo su 405/501 by design.
 */

async function checkOne({ url, text }, timeoutMs) {
  // Scheme guard: solo http/https supportati
  try {
    const proto = new URL(url).protocol;
    if (proto !== 'http:' && proto !== 'https:') {
      return { url, text, status: 0, ok: false, broken: true, error: 'Unsupported scheme' };
    }
  } catch {
    return { url, text, status: 0, ok: false, broken: true, error: 'Invalid URL' };
  }

  let lastError = null;
  for (const method of ['HEAD', 'GET']) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { method, redirect: 'follow', signal: ctrl.signal });
      clearTimeout(timer);
      if (method === 'HEAD' && (resp.status === 405 || resp.status === 501)) continue;
      if (method === 'GET') await resp.body?.cancel();
      return { url, text, status: resp.status, ok: resp.ok, broken: resp.status >= 400 };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError' || err.cause?.name === 'AbortError') {
        lastError = `timeout after ${timeoutMs}ms`;
        break;
      }
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
