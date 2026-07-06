#!/usr/bin/env node

/**
 * CLI di chrome-bridge: stessi comandi dei tool MCP, via Bash.
 *
 * Si connette come client relay al server WebSocket già attivo (mai come
 * primary: processo breve, non deve contendere la porta all'istanza MCP).
 * Pensata per batch e output filtrabili con pipe:
 *
 *   chrome-bridge tabs
 *   chrome-bridge read_console --tab-id 42 | grep -i error | head -5
 *   chrome-bridge js --code 'document.title'
 *   chrome-bridge screenshot --out /tmp/shot.png
 */

import WebSocket from 'ws';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, MessageType, createCommand, getTimeout } from './protocol.js';
import { consoleLines, networkLines, interactivesLines, linksLines } from './formatters.js';
import { checkLinksBatch } from './link-checker.js';
import { evaluateSecurityHeaders } from './security-headers.js';
import { toHar } from './har.js';

const INTERNAL_TYPES = new Set([
  MessageType.RESULT, MessageType.ERROR, MessageType.PING, MessageType.PONG,
  MessageType.EXT_INIT, MessageType.RELAY_INIT,
]);

// Comandi virtuali: logica lato CLI (come i corrispondenti tool MCP lato server)
const VIRTUAL_COMMANDS = new Set(['status', 'check_links', 'security_headers']);

const ALIASES = { tabs: 'get_tabs', js: 'execute_js', console: 'read_console', network: 'monitor_network', interactives: 'get_interactives' };

const VALID_COMMANDS = new Set([
  ...Object.values(MessageType).filter((t) => !INTERNAL_TYPES.has(t)),
  ...VIRTUAL_COMMANDS,
]);

// Opzioni consumate dalla CLI, mai inoltrate all'estensione
const CLI_OPTS = new Set(['out', 'format', 'max_chars']);

function coerce(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

export function parseCliArgs(argv) {
  const [cmdRaw, ...rest] = argv;
  if (!cmdRaw) throw new Error('Unknown command: (none). Run with --help.');
  const command = ALIASES[cmdRaw] ?? cmdRaw;
  if (!VALID_COMMANDS.has(command)) throw new Error(`Unknown command: ${cmdRaw}. Run with --help.`);

  const params = {};
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg} (flags are --key value)`);
    const key = arg.slice(2).replaceAll('-', '_');
    let value = true;
    if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
      value = coerce(rest[++i]);
    }
    if (key === 'json') {
      Object.assign(params, JSON.parse(value));
    } else if (CLI_OPTS.has(key)) {
      opts[key] = value;
    } else {
      params[key] = value;
    }
  }
  return { command, params, opts };
}

// ─── Connessione relay ───────────────────────────────────────────

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map();

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: MessageType.RELAY_INIT }));
      resolve({
        sendCommand(type, params = {}) {
          return new Promise((res, rej) => {
            const command = createCommand(type, params);
            const timer = setTimeout(() => {
              pending.delete(command.id);
              rej(new Error(`Command ${type} timed out after ${getTimeout(type)}ms`));
            }, getTimeout(type));
            pending.set(command.id, { res, rej, timer });
            ws.send(JSON.stringify(command));
          });
        },
        close: () => ws.close(),
      });
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.type === MessageType.ERROR) entry.rej(new Error(msg.error || 'Unknown error from extension'));
      else entry.res(msg.data);
    });

    ws.on('error', (err) => {
      reject(new Error(err.code === 'ECONNREFUSED'
        ? `chrome-bridge server not running on port ${port} — start a Claude Code session (MCP server) or run: npm start`
        : err.message));
    });
  });
}

// ─── Output helpers ──────────────────────────────────────────────

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.zip': 'application/zip', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function printResult(text, opts) {
  const max = opts.max_chars ?? 20000;
  if (max > 0 && text.length > max) {
    text = text.slice(0, max) + `\n…[truncated, ${text.length - max} more chars — use --max-chars 0 for full output, or pipe through grep/head]`;
  }
  process.stdout.write(text + '\n');
}

async function writeImages(images, outBase) {
  const paths = [];
  const dot = outBase.lastIndexOf('.');
  const stem = dot > 0 ? outBase.slice(0, dot) : outBase;
  const ext = dot > 0 ? outBase.slice(dot) : '.png';
  for (let i = 0; i < images.length; i++) {
    const path = images.length === 1 ? `${stem}${ext}` : `${stem}-${i + 1}${ext}`;
    await writeFile(path, Buffer.from(images[i], 'base64'));
    paths.push(path);
  }
  return paths;
}

// ─── Dispatch ────────────────────────────────────────────────────

async function run(client, command, params, opts) {
  // Comandi virtuali
  if (command === 'status') {
    const tabs = await client.sendCommand(MessageType.GET_TABS);
    return `server=ok extension=connected tabs=${Array.isArray(tabs) ? tabs.length : 0}`;
  }
  if (command === 'check_links') {
    const { timeout, ...collectParams } = params;
    const data = await client.sendCommand(MessageType.COLLECT_LINKS, collectParams);
    const links = data.links ?? [];
    const results = await checkLinksBatch(links, timeout ?? 5000);
    const broken = results.filter((r) => r.broken).length;
    if (opts.format === 'json') return JSON.stringify({ total: links.length, checked: results.length, broken, totalAnchors: data.totalAnchors, results });
    return linksLines(results, { total: links.length, broken, anchors: data.totalAnchors });
  }
  if (command === 'security_headers') {
    const data = await client.sendCommand(MessageType.GET_RESPONSE_HEADERS, params);
    if (!data.available) return JSON.stringify(data);
    const result = evaluateSecurityHeaders(data.headers, data.url);
    result.status = data.status;
    return JSON.stringify(result);
  }

  // Comandi con file I/O lato CLI
  if (command === 'upload_file') {
    const buf = await readFile(params.path);
    if (buf.length > 10 * 1024 * 1024) throw new Error(`File too large: ${buf.length} bytes (max 10MB)`);
    const mime = params.mime_type || MIME_BY_EXT[extname(params.path).toLowerCase()] || 'application/octet-stream';
    const data = await client.sendCommand(MessageType.UPLOAD_FILE, {
      selector: params.selector, name: basename(params.path), mime_type: mime,
      content_b64: buf.toString('base64'), tab_id: params.tab_id,
    });
    return JSON.stringify(data);
  }
  if (command === 'save_page') {
    if (!opts.out) throw new Error('save_page requires --out /path/to/page.mhtml');
    const data = await client.sendCommand(MessageType.SAVE_PAGE, params);
    await writeFile(opts.out, Buffer.from(data.mhtml_b64, 'base64'));
    return JSON.stringify({ saved: opts.out, size: data.size });
  }

  const data = await client.sendCommand(command, params);

  // Comandi che restituiscono immagini → file su disco
  if (command === 'screenshot' || command === 'element_screenshot') {
    if (!data?.image) return JSON.stringify(data);
    const [path] = await writeImages([data.image], opts.out ?? `chrome-bridge-shot-${Date.now()}.png`);
    return `saved ${path}`;
  }
  if (command === 'full_page_screenshot') {
    const images = data?.images ?? (data?.image ? [data.image] : data?.captures ?? []);
    if (!images.length) return JSON.stringify(data);
    const paths = await writeImages(images, opts.out ?? `chrome-bridge-fullpage-${Date.now()}.png`);
    return `saved ${paths.join(' ')} (${data.totalCaptures} captures, scrollHeight=${data.scrollHeight}${data.truncated ? ', truncated' : ''})`;
  }
  if (command === 'screenshot_diff' && data?.diff_image) {
    const { diff_image, ...rest } = data;
    const [path] = await writeImages([diff_image], opts.out ?? `chrome-bridge-diff-${Date.now()}.png`);
    return `saved ${path}\n${JSON.stringify(rest)}`;
  }

  // Formati lines condivisi coi tool MCP
  if (command === 'read_console' && opts.format !== 'json') {
    const all = data?.messages ?? [];
    return consoleLines(all.slice(-(params.limit ?? 50)), data?.count ?? all.length);
  }
  if (command === 'monitor_network' && opts.format !== 'json') {
    const all = data?.requests ?? [];
    const tail = all.slice(-(params.limit ?? 100));
    if (opts.format === 'har') return JSON.stringify(toHar(tail));
    return networkLines(tail, data?.count ?? all.length);
  }
  if (command === 'get_interactives' && opts.format !== 'json') {
    return interactivesLines(data);
  }
  if (command === 'read_page' && typeof data === 'string') {
    return data;
  }

  return JSON.stringify(data);
}

function printHelp() {
  const commands = [...VALID_COMMANDS].sort().join(', ');
  process.stdout.write(`chrome-bridge — CLI for the chrome-bridge WebSocket server

Usage:
  chrome-bridge <command> [--flag value ...] [--json '{...}']

Options:
  --out PATH        Output file for screenshot/save_page commands
  --format FMT      lines (default) | json | har (monitor_network)
  --max-chars N     Truncate output at N chars (default 20000, 0 = unlimited)
  --json '{...}'    Merge raw JSON into command params

Flags map to command params: --tab-id 42 → tab_id, --visible-only false, --force.
Requires a running chrome-bridge server (MCP session or npm start); connects as relay.

Aliases: ${Object.entries(ALIASES).map(([a, c]) => `${a}→${c}`).join(', ')}

Commands:
  ${commands}

Examples:
  chrome-bridge tabs
  chrome-bridge navigate --url https://example.com
  chrome-bridge read_console --tab-id 42 --level error | head -20
  chrome-bridge js --code 'document.title'
  chrome-bridge screenshot --out /tmp/shot.png
  chrome-bridge check_links --scope same-origin
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    printHelp();
    return;
  }
  const { command, params, opts } = parseCliArgs(argv);
  const port = parseInt(process.env.CHROME_BRIDGE_PORT || DEFAULT_PORT, 10);
  const client = await connect(port);
  try {
    printResult(await run(client, command, params, opts), opts);
  } finally {
    client.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  });
}
