/**
 * "Quale plugin rallenta la pagina?" — le voci di Resource Timing raggruppate
 * per chi le ha causate: plugin e tema WordPress, modulo PrestaShop, il sito
 * stesso, ogni host di terze parti. Funzioni pure sui dati che l'estensione
 * legge da performance.getEntriesByType('resource').
 */

const GROUPERS = [
  [/\/wp-content\/plugins\/([^/]+)\//, (m) => `plugin:${m[1]}`],
  [/\/wp-content\/themes\/([^/]+)\//, (m) => `theme:${m[1]}`],
  [/\/wp-content\/uploads\//, () => 'uploads'],
  [/\/wp-includes\//, () => 'wp-core'],
  [/\/modules\/([^/]+)\//, (m) => `module:${m[1]}`],
  [/\/themes\/([^/]+)\//, (m) => `theme:${m[1]}`],
];

function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }

export function groupKey(url, pageHost) {
  const host = hostOf(url);
  if (host && host !== pageHost) return host;
  for (const [re, name] of GROUPERS) {
    const m = re.exec(url);
    if (m) return name(m);
  }
  return 'site';
}

/**
 * @param {Array<{name:string, duration?:number, transfer?:number, size?:number, blocking?:string, type?:string}>} entries
 */
export function groupResources(entries = [], { pageHost = '', top = 15 } = {}) {
  const groups = new Map();
  for (const e of entries) {
    if (!e?.name) continue;
    const key = groupKey(e.name, pageHost);
    const g = groups.get(key) ?? { group: key, requests: 0, transfer: 0, duration: 0, max_duration: 0, blocking: 0, slowest: null };
    g.requests += 1;
    g.transfer += Number(e.transfer || 0);
    g.duration += Number(e.duration || 0);
    if (Number(e.duration || 0) > g.max_duration) { g.max_duration = Number(e.duration || 0); g.slowest = e.name; }
    if (e.blocking === 'blocking') g.blocking += 1;
    groups.set(key, g);
  }
  const all = [...groups.values()].sort((a, b) => (b.duration - a.duration) || (b.transfer - a.transfer));
  return { groups: all.slice(0, top), total_groups: all.length, total_requests: entries.length, total_transfer: all.reduce((s, g) => s + g.transfer, 0) };
}

export function resourceLines(r, nav = {}) {
  const head = `resources requests=${r.total_requests} groups=${r.total_groups} transfer=${(r.total_transfer / 1024).toFixed(0)}KB`
    + (nav.dom_content_loaded != null ? ` DCL=${nav.dom_content_loaded}ms` : '') + (nav.load != null ? ` load=${nav.load}ms` : '');
  const lines = r.groups.map((g) => [g.group, `${g.requests} req`, `${(g.transfer / 1024).toFixed(0)}KB`, `${Math.round(g.duration)}ms`, g.blocking ? `${g.blocking} blocking` : '', g.slowest ? `slowest ${Math.round(g.max_duration)}ms ${g.slowest.split('/').slice(-1)[0].slice(0, 60)}` : ''].filter(Boolean).join('\t'));
  return `${head}\n${lines.join('\n')}`;
}
