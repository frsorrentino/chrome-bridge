/**
 * "La CDN serve la versione nuova?" — la stessa risorsa chiesta due volte,
 * normale e con cache-buster, e il confronto dei validatori (ETag,
 * Last-Modified, Content-Length) più lo stato di cache dichiarato dalla CDN.
 * Funzioni pure: le richieste le fa l'estensione col profilo dell'utente.
 */

const CACHE_STATUS_HEADERS = ['cf-cache-status', 'x-cache', 'x-vercel-cache', 'x-nf-cache', 'x-cache-status', 'x-proxy-cache', 'x-fastly-cache', 'x-sg-cache', 'x-litespeed-cache'];

function h(res, name) { return res?.headers?.[name] ?? res?.headers?.[name.toLowerCase()] ?? null; }

/**
 * @param {{status:number, headers:object, size?:number}} cached  risposta normale
 * @param {{status:number, headers:object, size?:number}} fresh   risposta con cache-buster
 */
export function cacheVerdict(cached, fresh) {
  const status = CACHE_STATUS_HEADERS.map((n) => [n, h(cached, n)]).find(([, v]) => v);
  const age = h(cached, 'age');
  const etagA = h(cached, 'etag'); const etagB = h(fresh, 'etag');
  const lmA = h(cached, 'last-modified'); const lmB = h(fresh, 'last-modified');
  const lenA = h(cached, 'content-length') ?? cached?.size ?? null; const lenB = h(fresh, 'content-length') ?? fresh?.size ?? null;
  let verdict, basis;
  if (etagA && etagB) { verdict = etagA === etagB ? 'fresh' : 'stale'; basis = 'etag'; }
  else if (lmA && lmB) { verdict = lmA === lmB ? 'fresh' : 'stale'; basis = 'last-modified'; }
  else if (lenA != null && lenB != null) { verdict = String(lenA) === String(lenB) ? 'probably fresh' : 'differs'; basis = 'content-length'; }
  else { verdict = 'unknown'; basis = 'no validators'; }
  if (cached?.status !== fresh?.status) { verdict = 'differs'; basis = `status ${cached?.status} vs ${fresh?.status}`; }
  return {
    verdict, basis,
    cache_status: status ? `${status[0]}=${status[1]}` : null,
    age: age != null ? Number(age) : null,
    cache_control: h(cached, 'cache-control'),
    etag: etagA, etag_fresh: etagB, last_modified: lmA, last_modified_fresh: lmB,
  };
}

export function cacheLines(rows) {
  const stale = rows.filter((r) => /stale|differs/.test(r.verdict)).length;
  const lines = rows.map((r) => [r.verdict, r.url.length > 90 ? r.url.slice(0, 87) + '…' : r.url, r.cache_status ?? '-', r.age != null ? `age ${r.age}s` : '', r.basis, r.error ?? ''].filter((x) => x !== '').join('\t'));
  return `cache check urls=${rows.length} stale_or_different=${stale}\n${lines.join('\n')}`;
}
