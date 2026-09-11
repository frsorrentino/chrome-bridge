#!/usr/bin/env node
/**
 * Latenza per tool sul percorso reale: un client MCP su stdio parla al server,
 * il server all'estensione via WebSocket, l'estensione alla pagina. Niente
 * scorciatoie: se un tool siede su un timeout, qui si vede.
 *
 * Uso: node bench/latency.mjs [--rounds 5] [--threshold 2000] [--headed]
 *                             [--out docs/PERFORMANCE.md] [--verbose]
 *
 * Avvia da solo un Chromium dedicato (launch mode, porta effimera) e un server
 * statico per bench/form.html e bench/heavy.html: nessuna dipendenza di rete,
 * nessun conflitto con un bridge già attivo sulla 8765.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { summarize, renderReport } from './latency-stats.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const ROUNDS = parseInt(flag('--rounds', '5'), 10);
const THRESHOLD = parseInt(flag('--threshold', '2000'), 10);
const OUT = resolve(ROOT, flag('--out', 'docs/PERFORMANCE.md'));
const HEADED = argv.includes('--headed');
const VERBOSE = argv.includes('--verbose');
const DATE = new Date().toISOString().slice(0, 10);

const log = (...a) => console.error('[latency]', ...a);

// --- pagine locali ---------------------------------------------------------
async function startStatic() {
  const server = createServer(async (req, res) => {
    const file = req.url === '/heavy.html' ? 'heavy.html' : 'form.html';
    try {
      const body = await readFile(join(ROOT, 'bench', file));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
      res.end(body);
    } catch (err) {
      res.writeHead(500); res.end(String(err.message));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// --- client MCP sul server in launch mode -----------------------------------
function textOf(result) {
  return (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}
function jsonOf(result) {
  try { return JSON.parse(textOf(result)); } catch { return null; }
}

async function main() {
  const { server: staticServer, base } = await startStatic();
  const env = { ...process.env };
  delete env.CHROME_BRIDGE_PORT; // launch mode vuole una porta effimera
  delete env.CHROME_BRIDGE_TOKEN;
  const args = [join(ROOT, 'server', 'index.js'), '--launch', '--caps', 'all'];
  if (!HEADED) args.push('--headless');
  const transport = new StdioClientTransport({ command: process.execPath, args, env, stderr: 'pipe' });
  transport.stderr?.on('data', (d) => { if (VERBOSE) process.stderr.write(d); });
  const client = new Client({ name: 'chrome-bridge-latency', version: '1' });

  const t0 = performance.now();
  await client.connect(transport);
  let status = null;
  while (performance.now() - t0 < 60000) {
    status = jsonOf(await client.callTool({ name: 'get_status', arguments: {} }));
    if (status?.connected) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!status?.connected) throw new Error('extension did not connect within 60 s');
  const coldStart = performance.now() - t0;
  log(`extension connected in ${Math.round(coldStart)} ms (server ${status.version}, extension ${status.extension_version})`);

  const created = jsonOf(await client.callTool({ name: 'create_tab', arguments: { url: `${base}/form.html`, active: true } }));
  const tabId = created?.id ?? created?.tabId;
  if (tabId == null) throw new Error(`create_tab gave no id: ${JSON.stringify(created)}`);
  await client.callTool({ name: 'wait_for', arguments: { condition: 'element', selector: '#reg', tab_id: tabId, timeout: 10000 } });

  let chrome = '?';
  const ua = await client.callTool({ name: 'execute_js', arguments: { code: 'navigator.userAgent', tab_id: tabId } });
  const m = textOf(ua).match(/Chrome\/([\d.]+)/);
  if (m) chrome = m[1];

  const T = (name, args, note) => ({ name, args: { ...args, tab_id: tabId }, note });
  const plan = [
    { name: 'get_status', args: {}, note: 'transport only, no page' },
    { name: 'get_tabs', args: {}, note: 'transport + tab query' },
    T('navigate', { url: `${base}/form.html` }, 'form.html, load + interactives preview'),
    T('get_page_info', {}, 'metas, scripts, links, forms'),
    T('read_page', { mode: 'text' }, 'form.html as text'),
    T('get_interactives', {}, 'form.html, 7 controls'),
    T('find_text', { text: 'Regione' }, 'one match'),
    T('query_dom', { selector: 'input', properties: ['display'] }, '5 inputs with a computed style'),
    T('wait_for', { condition: 'element', selector: '#privacy' }, 'element already present'),
    T('scroll', { action: 'to', selector: 'button' }, 'scroll to the submit button'),
    T('click', { selector: 'label' }, 'a label: focuses a field, no navigation'),
    T('type_text', { selector: '#nome', text: 'Mario Rossi' }, 'native setter'),
    T('fill_form', { fields: [{ selector: '#email', value: 'mario@example.com' }, { selector: '#telefono', value: '0961123456' }] }, 'two fields, no submit'),
    T('screenshot', {}, 'viewport PNG, base64'),
    T('element_screenshot', { selector: '#reg' }, 'the form, cropped'),
    T('read_console', {}, 'buffer read'),
    T('execute_js', { code: '1 + 1' }, 'trivial expression'),
    T('navigate', { url: `${base}/heavy.html` }, 'heavy.html, 1500-row table'),
    T('extract_table', { selector: '#catalog', where: { SKU: 'SKU-0777' } }, '1500 rows, server-side where'),
    T('read_page', { mode: 'text' }, 'heavy.html as text'),
  ];

  const rows = [];
  for (const step of plan) {
    const samples = [];
    let note = step.note;
    for (let i = 0; i < ROUNDS; i++) {
      const s = performance.now();
      let res;
      try { res = await client.callTool({ name: step.name, arguments: step.args }); } catch (err) { note = `${note}; error: ${err.message.slice(0, 80)}`; break; }
      const dt = performance.now() - s;
      if (res?.isError) { note = `${note}; error: ${textOf(res).slice(0, 80)}`; break; }
      samples.push(dt);
    }
    const row = { tool: step.name, note, samples: samples.map((v) => Math.round(v * 10) / 10), ...summarize(samples) };
    rows.push(row);
    log(`${step.name.padEnd(20)} median ${row.median == null ? '—' : Math.round(row.median)} ms  (${samples.length}/${ROUNDS})${note !== step.note ? `  ${note}` : ''}`);
  }

  const report = {
    date: DATE,
    env: { node: process.version, chrome, extension: status.extension_version ?? '?', server: status.version ?? '?', platform: `${process.platform} ${process.arch}` },
    rounds: ROUNDS,
    threshold_ms: THRESHOLD,
    cold_start_ms: coldStart,
    rows,
  };
  await mkdir(join(ROOT, 'bench', 'results'), { recursive: true });
  const jsonPath = join(ROOT, 'bench', 'results', `latency-${DATE}.json`);
  await writeFile(jsonPath, JSON.stringify(report, null, 1));
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, renderReport(report));
  log(`wrote ${OUT} and ${jsonPath}`);

  try { await client.close(); } catch {}
  staticServer.close();
}

main().catch((err) => { log('fatal:', err.message); process.exit(1); });
