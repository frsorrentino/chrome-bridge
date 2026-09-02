/**
 * `audit`: i sei audit (a11y, SEO, security header, link, web vitals, CSS
 * inutilizzato) in una chiamata, con un riassunto per la chat e il report
 * completo su disco. Nell'unico log d'uso esistente i sei tool separati
 * avevano zero chiamate: sei ingressi non vengono attraversati, uno sì.
 *
 * runAudit è condiviso da tool MCP e CLI: riceve sendCommand e non sa chi lo
 * chiama.
 */
import { MessageType } from './protocol.js';
import { checkLinksBatch } from './link-checker.js';
import { evaluateSecurityHeaders } from './security-headers.js';

export const AUDIT_KINDS = ['a11y', 'seo', 'security', 'links', 'vitals', 'css'];
export const DEFAULT_KINDS = ['a11y', 'seo', 'security', 'links', 'vitals'];

const RUNNERS = {
  a11y: (send, o) => send(MessageType.ACCESSIBILITY_AUDIT, { scope: o.scope, checks: ['all'], tab_id: o.tab_id }),
  seo: (send, o) => send(MessageType.SEO_AUDIT, { tab_id: o.tab_id }),
  security: async (send, o) => {
    const data = await send(MessageType.GET_RESPONSE_HEADERS, { tab_id: o.tab_id });
    if (!data?.available) return data;
    const r = evaluateSecurityHeaders(data.headers, data.url);
    r.status = data.status;
    return r;
  },
  links: async (send, o) => {
    const data = await send(MessageType.COLLECT_LINKS, { scope: o.links_scope ?? 'all', selector: 'a[href]', max_links: o.max_links ?? 50, tab_id: o.tab_id });
    const links = data?.links ?? [];
    const results = await checkLinksBatch(links, o.link_timeout ?? 5000);
    return { total: links.length, checked: results.length, broken: results.filter((r) => r.broken).length, totalAnchors: data?.totalAnchors, results };
  },
  vitals: (send, o) => send(MessageType.WEB_VITALS, { tab_id: o.tab_id }),
  css: (send, o) => send(MessageType.UNUSED_CSS, { max_selectors: o.max_selectors ?? 200, tab_id: o.tab_id }),
};

/** Esegue i kind richiesti in sequenza; un errore in uno non ferma gli altri. */
export async function runAudit(send, { kinds = DEFAULT_KINDS, ...opts } = {}) {
  const results = {};
  for (const kind of kinds) {
    if (!RUNNERS[kind]) { results[kind] = { error: `unknown kind "${kind}" (known: ${AUDIT_KINDS.join(', ')})` }; continue; }
    try { results[kind] = await RUNNERS[kind](send, opts); }
    catch (err) { results[kind] = { error: err.message }; }
  }
  return results;
}

function pick(obj, keys) { const o = {}; for (const k of keys) if (obj?.[k] !== undefined) o[k] = obj[k]; return o; }

/** Numeri che decidono, non tutto: una riga per kind. */
export function summarizeAudit(results) {
  const lines = [];
  const counts = {};
  for (const [kind, r] of Object.entries(results)) {
    if (!r || r.error) { lines.push(`${kind}: error — ${r?.error ?? 'no result'}`); continue; }
    switch (kind) {
      case 'a11y': {
        const v = r.violations ?? [];
        const byType = {};
        for (const x of v) byType[x.type] = (byType[x.type] || 0) + 1;
        counts.a11y = { errors: r.summary?.errors ?? v.filter((x) => x.severity === 'error').length, warnings: r.summary?.warnings ?? v.filter((x) => x.severity === 'warning').length };
        lines.push(`a11y: ${counts.a11y.errors} errors, ${counts.a11y.warnings} warnings` + (v.length ? ` (${Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(', ')})` : ''));
        break;
      }
      case 'seo': {
        const f = r.findings ?? [];
        counts.seo = { errors: r.summary?.errors ?? 0, warnings: r.summary?.warnings ?? 0 };
        const top = f.filter((x) => x.severity === 'error').slice(0, 3).map((x) => x.message ?? x.check ?? JSON.stringify(x));
        lines.push(`seo: ${counts.seo.errors} errors, ${counts.seo.warnings} warnings` + (top.length ? ` — ${top.join('; ')}` : ''));
        break;
      }
      case 'security': {
        if (r.available === false) { lines.push(`security: headers not captured — ${r.note ?? 'reload the page'}`); break; }
        const f = r.findings ?? [];
        counts.security = { errors: r.summary?.errors ?? 0, warnings: r.summary?.warnings ?? 0, info: r.summary?.info ?? 0 };
        const worst = f.filter((x) => x.severity === 'error').slice(0, 4).map((x) => x.header ?? x.message);
        lines.push(`security: ${counts.security.errors} errors, ${counts.security.warnings} warnings, ${counts.security.info} info` + (worst.length ? ` — ${worst.join(', ')}` : ''));
        break;
      }
      case 'links': {
        counts.links = { checked: r.checked, broken: r.broken };
        const broken = (r.results ?? []).filter((x) => x.broken).slice(0, 5).map((x) => `${x.status ? x.status : x.error} ${x.url}`);
        lines.push(`links: ${r.broken} broken of ${r.checked} checked (${r.total} collected)` + (broken.length ? ` — ${broken.join('; ')}` : ''));
        break;
      }
      case 'vitals': {
        if (r.available === false || r.hooked === false) { lines.push(`vitals: not measured — ${r.note ?? 'instrumentation not active'}`); break; }
        counts.vitals = pick(r, ['cls', 'lcp_ms', 'fcp_ms', 'ttfb_ms', 'inp_ms', 'long_tasks']);
        lines.push(`vitals: ${Object.entries(counts.vitals).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        break;
      }
      case 'css': {
        counts.css = { unused: r.total_unused ?? r.totalUnused ?? (r.unused_selectors ?? r.unusedSelectors ?? []).length, checked: r.total_checked ?? r.totalChecked ?? null };
        lines.push(`css: ${counts.css.unused} unused selector(s)${counts.css.checked != null ? ` of ${counts.css.checked}` : ''}`);
        break;
      }
      default:
        lines.push(`${kind}: ${JSON.stringify(r).slice(0, 200)}`);
    }
  }
  return { lines, counts };
}

/** Report Markdown: riassunto in testa, poi il JSON completo per kind. */
export function auditReport({ url, title, when = new Date(), results, summary }) {
  const out = [`# Audit — ${title || url}`, '', `- URL: ${url}`, `- Date: ${when.toISOString()}`, `- Kinds: ${Object.keys(results).join(', ')}`, '', '## Summary', ''];
  for (const l of summary.lines) out.push(`- ${l}`);
  for (const [kind, r] of Object.entries(results)) {
    out.push('', `## ${kind}`, '', '```json', JSON.stringify(r, null, 2), '```');
  }
  return out.join('\n') + '\n';
}
