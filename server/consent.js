/**
 * Audit di cookie e consenso: confronto puro fra due fotografie (prima e dopo
 * il clic sul banner) di cookie e richieste di rete. La domanda che il
 * Garante fa è una sola — cosa parte PRIMA del consenso — e la risposta deve
 * uscire da qui senza che il modello debba leggersi il log grezzo.
 */

const TRACKER_HOSTS = [
  [/google-analytics\.com|analytics\.google\.com/, 'analytics'],
  [/googletagmanager\.com/, 'tag manager'],
  [/doubleclick\.net|googleadservices\.com|googlesyndication\.com/, 'advertising'],
  [/facebook\.(?:com|net)/, 'advertising'],
  [/tiktok\.com/, 'advertising'],
  [/linkedin\.com/, 'advertising'],
  [/pinterest\.com/, 'advertising'],
  [/bing\.com/, 'advertising'],
  [/criteo\.(?:com|net)|taboola\.com|outbrain\.com/, 'advertising'],
  [/hotjar\.com|clarity\.ms|mouseflow\.com|fullstory\.com/, 'session recording'],
  [/hubspot\.com|hs-scripts\.com|intercom\.io|crisp\.chat/, 'marketing/chat'],
  [/youtube\.com|ytimg\.com|vimeo\.com/, 'embed'],
  [/fonts\.googleapis\.com|fonts\.gstatic\.com/, 'fonts'],
];

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

/** Dominio registrabile approssimato: ultimi due label, tre se il secondo è co/com/org… */
export function siteOf(host = '') {
  const parts = String(host).toLowerCase().replace(/^\./, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const n = SECOND_LEVEL.has(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-n).join('.');
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function trackerCategory(host) {
  for (const [re, cat] of TRACKER_HOSTS) if (re.test(host)) return cat;
  return null;
}

function cookieKey(c) { return `${c.name}@${(c.domain || '').replace(/^\./, '')}`; }

function thirdParties(requests, site) {
  const byHost = new Map();
  for (const r of requests || []) {
    const h = hostOf(r.url);
    if (!h || siteOf(h) === site) continue;
    const e = byHost.get(h) ?? { host: h, requests: 0, category: trackerCategory(h) };
    e.requests += 1;
    byHost.set(h, e);
  }
  return [...byHost.values()].sort((a, b) => b.requests - a.requests);
}

/**
 * @param {{pageUrl:string, cookiesBefore:Array, requestsBefore:Array, cookiesAfter:Array, requestsAfter:Array, consent:string}} snap
 */
export function summarizeConsent({ pageUrl, cookiesBefore = [], requestsBefore = [], cookiesAfter = [], requestsAfter = [], consent = 'none' }) {
  const site = siteOf(hostOf(pageUrl));
  const before = {
    cookies: cookiesBefore.map((c) => ({ name: c.name, domain: (c.domain || '').replace(/^\./, ''), third_party: siteOf(c.domain || '') !== site })),
    third_party: thirdParties(requestsBefore, site),
  };
  const seen = new Set(cookiesBefore.map(cookieKey));
  const seenHosts = new Set(before.third_party.map((t) => t.host));
  const after = {
    new_cookies: cookiesAfter.filter((c) => !seen.has(cookieKey(c))).map((c) => ({ name: c.name, domain: (c.domain || '').replace(/^\./, ''), third_party: siteOf(c.domain || '') !== site })),
    new_third_party: thirdParties(requestsAfter, site).filter((t) => !seenHosts.has(t.host)),
  };
  const trackersBefore = before.third_party.filter((t) => t.category && !['fonts', 'embed'].includes(t.category));
  const findings = [];
  if (trackersBefore.length) findings.push(`${trackersBefore.length} tracking host(s) contacted before consent: ${trackersBefore.map((t) => t.host).join(', ')}`);
  const tpCookiesBefore = before.cookies.filter((c) => c.third_party);
  if (tpCookiesBefore.length) findings.push(`${tpCookiesBefore.length} third-party cookie(s) set before consent: ${tpCookiesBefore.map((c) => c.name).join(', ')}`);
  if (consent === 'none') findings.push('no consent action performed: the "after" columns are empty by design');
  if (!findings.length) findings.push('nothing third-party fired before consent');
  return { site, consent, before, after, findings };
}

/** Testo compatto per il modello. */
export function consentLines(s) {
  const out = [`consent audit site=${s.site} consent=${s.consent}`];
  out.push(`before consent: cookies=${s.before.cookies.length} (third-party ${s.before.cookies.filter((c) => c.third_party).length}), third-party hosts=${s.before.third_party.length}`);
  for (const t of s.before.third_party) out.push(`  ${t.host}\t${t.requests} req${t.category ? `\t${t.category}` : ''}`);
  for (const c of s.before.cookies) out.push(`  cookie ${c.name}\t${c.domain}${c.third_party ? '\tthird-party' : ''}`);
  if (s.consent !== 'none') {
    out.push(`after consent: new cookies=${s.after.new_cookies.length}, new third-party hosts=${s.after.new_third_party.length}`);
    for (const t of s.after.new_third_party) out.push(`  ${t.host}\t${t.requests} req${t.category ? `\t${t.category}` : ''}`);
    for (const c of s.after.new_cookies) out.push(`  cookie ${c.name}\t${c.domain}${c.third_party ? '\tthird-party' : ''}`);
  }
  out.push('findings:');
  for (const f of s.findings) out.push(`  - ${f}`);
  return out.join('\n');
}
