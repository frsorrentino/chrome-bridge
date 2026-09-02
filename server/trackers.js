/**
 * Decodifica dei beacon di tracciamento (GA4, Meta, Google Ads, TikTok,
 * LinkedIn, Pinterest, Microsoft Ads, Hotjar, Clarity…) a partire dal log di
 * rete browser-side. Funzioni pure: nessun accesso al browser, testabili in
 * Node. I parametri stanno nella query string; i corpi POST non passano dal
 * log webRequest e vengono dichiarati come non decodificati, non inventati.
 */

const VENDORS = [
  // [test sull'URL, vendor, decoder]
  [/(?:google-analytics\.com|analytics\.google\.com|googletagmanager\.com)\/g\/collect/i, 'GA4', (u) => ({
    event: u.searchParams.get('en') || '(body)',
    params: pick(u, ['tid', 'cu', 'dl'], /^ep\.|^epn\./),
  })],
  [/google-analytics\.com\/(?:r\/|j\/)?collect/i, 'Universal Analytics', (u) => ({
    event: u.searchParams.get('t') === 'event' ? `${u.searchParams.get('ec')}/${u.searchParams.get('ea')}` : (u.searchParams.get('t') || 'hit'),
    params: pick(u, ['tid', 'el', 'ev']),
  })],
  [/facebook\.com\/tr\b/i, 'Meta Pixel', (u) => ({
    event: u.searchParams.get('ev') || '(body)',
    params: pick(u, ['id'], /^cd\[/),
  })],
  [/(?:googleadservices\.com|google\.com)\/pagead\/(?:1p-)?conversion\/(\d+)/i, 'Google Ads', (u, m) => ({
    event: `conversion ${m[1]}`,
    params: pick(u, ['label', 'value', 'currency_code']),
  })],
  [/analytics\.tiktok\.com\/api\/v2\/pixel/i, 'TikTok', () => ({ event: '(body)', params: {} })],
  [/px\.ads\.linkedin\.com\/collect/i, 'LinkedIn', (u) => ({
    event: u.searchParams.get('conversionId') ? `conversion ${u.searchParams.get('conversionId')}` : 'pageview',
    params: pick(u, ['pid']),
  })],
  [/ct\.pinterest\.com\/v3/i, 'Pinterest', (u) => ({ event: u.searchParams.get('event') || 'load', params: pick(u, ['tid']) })],
  [/bat\.bing\.com\/action/i, 'Microsoft Ads', (u) => ({ event: u.searchParams.get('evt') || 'pageLoad', params: pick(u, ['ti', 'gv', 'gc']) })],
  [/googletagmanager\.com\/gtm\.js/i, 'GTM', (u) => ({ event: `container ${u.searchParams.get('id')} loaded`, params: {} })],
  [/googletagmanager\.com\/gtag\/js/i, 'gtag', (u) => ({ event: `library ${u.searchParams.get('id')} loaded`, params: {} })],
  [/connect\.facebook\.net\/.*fbevents\.js/i, 'Meta Pixel', () => ({ event: 'library loaded', params: {} })],
  [/static\.hotjar\.com|script\.hotjar\.com/i, 'Hotjar', () => ({ event: 'library loaded', params: {} })],
  [/clarity\.ms\/(?:tag|collect)/i, 'Clarity', () => ({ event: 'hit', params: {} })],
];

function pick(u, keys, prefixRe) {
  const out = {};
  for (const [k, v] of u.searchParams) {
    if (keys.includes(k) || (prefixRe && prefixRe.test(k))) out[k] = v;
  }
  return out;
}

/**
 * @param {Array<{url:string, method?:string, startTime?:number, status?:number}>} requests
 * @returns {{events: Array<{t:number, vendor:string, event:string, params:object, method:string, status?:number, url:string}>, first_ts:number|null}}
 */
export function decodeTrackingRequests(requests = []) {
  const events = [];
  let first = null;
  for (const r of requests) {
    if (!r?.url) continue;
    let u;
    try { u = new URL(r.url); } catch { continue; }
    for (const [re, vendor, decode] of VENDORS) {
      const m = re.exec(r.url);
      if (!m) continue;
      const ts = Number(r.startTime ?? r.ts ?? 0) || 0;
      if (first === null || (ts && ts < first)) first = ts;
      const { event, params } = decode(u, m);
      events.push({ t: ts, vendor, event, params, method: r.method || 'GET', status: r.status, url: r.url });
      break;
    }
  }
  events.sort((a, b) => a.t - b.t);
  return { events, first_ts: first };
}

/** Una riga per evento: "+ms  vendor  evento  k=v k=v". */
export function trackingLines({ events, first_ts }) {
  if (!events.length) return 'tracking events=0 (no known vendor beacons in the browser network log — was source=browser monitoring on before the action?)';
  const lines = events.map((e) => {
    const rel = first_ts ? `+${Math.max(0, Math.round(e.t - first_ts))}ms` : '';
    const kv = Object.entries(e.params).map(([k, v]) => `${k}=${v}`).join(' ');
    const body = e.event === '(body)' ? ' [params in POST body, not decoded]' : '';
    return [rel, e.vendor, e.event + body, kv].filter(Boolean).join('\t');
  });
  const vendors = [...new Set(events.map((e) => e.vendor))];
  return `tracking events=${events.length} vendors=${vendors.join(',')}\n${lines.join('\n')}`;
}
