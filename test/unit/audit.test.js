/**
 * `audit`: sei audit in una chiamata. Un kind che fallisce non ferma gli
 * altri; il riassunto è una riga per kind con i numeri che decidono; il report
 * su disco porta tutto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAudit, summarizeAudit, auditReport, DEFAULT_KINDS } from '../../server/audit.js';
import { registerTools } from '../../server/tools.js';
import { MessageType } from '../../server/protocol.js';

const fakeSend = async (type, p) => {
  switch (type) {
    case MessageType.GET_PAGE_INFO: return { url: 'https://a.it/', title: 'A' };
    case MessageType.ACCESSIBILITY_AUDIT: return { summary: { total: 2, errors: 1, warnings: 1 }, violations: [{ type: 'images', severity: 'error', message: 'Image missing alt' }, { type: 'headings', severity: 'warning', message: 'skip' }] };
    case MessageType.SEO_AUDIT: return { summary: { errors: 1, warnings: 0, info: 2 }, findings: [{ severity: 'error', message: 'Missing meta description' }] };
    case MessageType.GET_RESPONSE_HEADERS: return { available: true, status: 200, url: 'https://a.it/', headers: { 'content-type': 'text/html' } };
    case MessageType.COLLECT_LINKS: return { links: [], totalAnchors: 0 };
    case MessageType.WEB_VITALS: throw new Error('Instrumentation not loaded');
    case MessageType.UNUSED_CSS: return { total_unused: 12, total_checked: 300, unused_selectors: [] };
    default: return {};
  }
};

test('runAudit esegue i kind richiesti e isola gli errori', async () => {
  const r = await runAudit(fakeSend, { kinds: [...DEFAULT_KINDS, 'css', 'bogus'] });
  assert.deepEqual(Object.keys(r), ['a11y', 'seo', 'security', 'links', 'vitals', 'css', 'bogus']);
  assert.match(r.vitals.error, /Instrumentation/);
  assert.match(r.bogus.error, /unknown kind/);
  assert.ok(r.security.summary.warnings + r.security.summary.errors > 0, 'una pagina https senza header di sicurezza ha rilievi');
});

test('summarizeAudit produce una riga per kind con i numeri che contano', async () => {
  const r = await runAudit(fakeSend, { kinds: [...DEFAULT_KINDS, 'css'] });
  const s = summarizeAudit(r);
  assert.match(s.lines[0], /^a11y: 1 errors, 1 warnings \(images 1, headings 1\)/);
  assert.match(s.lines[1], /^seo: 1 errors, 0 warnings — Missing meta description/);
  assert.match(s.lines[2], /^security: \d+ errors, \d+ warnings, \d+ info/);
  assert.match(s.lines[3], /^links: 0 broken of 0 checked/);
  assert.match(s.lines[4], /^vitals: error — Instrumentation/);
  assert.match(s.lines[5], /^css: 12 unused selector\(s\) of 300/);
  assert.equal(s.counts.css.unused, 12);
});

test('auditReport è Markdown con riassunto e JSON completo per kind', async () => {
  const r = await runAudit(fakeSend, { kinds: ['a11y'] });
  const md = auditReport({ url: 'https://a.it/', title: 'A', when: new Date('2026-09-02T00:00:00Z'), results: r, summary: summarizeAudit(r) });
  assert.match(md, /^# Audit — A\n/);
  assert.match(md, /- Date: 2026-09-02T00:00:00.000Z/);
  assert.match(md, /## Summary\n\n- a11y: 1 errors/);
  assert.match(md, /## a11y\n\n```json\n\{\n  "summary"/);
});

test('il tool audit riassume in chat e scrive il report con save_to', async () => {
  const handlers = new Map();
  registerTools({ tool: (n, _d, s, ...rest) => handlers.set(n, rest[rest.length - 1]) }, { isConnected: () => true, mode: 'primary', host: 'h', port: 1, sendCommand: fakeSend }, 'all');
  const dir = await mkdtemp(join(tmpdir(), 'cb-audit-'));
  const out = join(dir, 'audit.md');
  const res = await handlers.get('audit')({ kinds: ['a11y', 'seo'], save_to: out, max_links: 50 });
  const text = res.content[0].text;
  assert.match(text, /^audit https:\/\/a\.it\/\na11y: 1 errors/);
  assert.match(text, /report: .*audit\.md$/);
  assert.match(await readFile(out, 'utf8'), /## seo/);
  const res2 = await handlers.get('audit')({ kinds: ['a11y'], max_links: 50 });
  assert.match(res2.content[0].text, /pass save_to for the full report/);
});
