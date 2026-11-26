/**
 * plugin/ è la cartella che Claude Code installa (marketplace.json: source "./plugin").
 * Dentro c'è solo ciò che gira: il server incorporato in dist/ (niente npx, niente
 * download da npm) e le copie di skills/ commands/ hooks/ observe/. extension/ no:
 * l'estensione arriva dal Chrome Web Store e il plugin non avvia mai il launch mode.
 * Questi test falliscono se plugin/ non è stato rigenerato dopo un cambio, se esce dai
 * limiti della directory (512 file, 256 KiB a file, niente link) o se il bundle non
 * risponde come server/index.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlugin } from '../../tools/build-plugin.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN = join(ROOT, 'plugin');

function walk(dir, base = dir, out = new Map()) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) walk(p, base, out);
    else out.set(relative(base, p).split('\\').join('/'), st);
  }
  return out;
}

test('plugin/ è aggiornata: rigenerarla con tools/build-plugin.mjs non cambia niente', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'cb-plugin-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  buildPlugin(tmp);
  const fresh = walk(tmp);
  const cur = new Map([...walk(PLUGIN)].filter(([p]) => !p.startsWith('.claude-plugin/')));
  const missing = [...fresh.keys()].filter((p) => !cur.has(p));
  const extra = [...cur.keys()].filter((p) => !fresh.has(p));
  const changed = [...fresh.keys()].filter((p) => cur.has(p)
    && !readFileSync(join(tmp, p)).equals(readFileSync(join(PLUGIN, p))));
  assert.deepEqual({ missing, extra, changed }, { missing: [], extra: [], changed: [] },
    'plugin/ è vecchia: node tools/build-plugin.mjs');
});

test('plugin/ sta nei limiti della directory: meno di 512 file, ognuno sotto 256 KiB, niente link', () => {
  const files = walk(PLUGIN);
  assert.ok(files.size < 512, `${files.size} file`);
  const big = [...files].filter(([, st]) => st.size >= 256 * 1024).map(([p, st]) => `${p} ${st.size}`);
  assert.deepEqual(big, []);
  assert.deepEqual([...files].filter(([, st]) => st.isSymbolicLink()).map(([p]) => p), []);
});

test('il manifest avvia il server incorporato con node, senza npx', () => {
  const plugin = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  const srv = plugin.mcpServers['chrome-bridge'];
  assert.equal(srv.command, 'node');
  assert.deepEqual(srv.args, ['${CLAUDE_PLUGIN_ROOT}/dist/index.js']);
  assert.ok(existsSync(join(PLUGIN, 'dist', 'index.js')));
  // 1.33.1: il portale non riconosce icon e privacyPolicyUrl, e Claude Code non li usa.
  assert.equal(plugin.icon, undefined);
  assert.equal(plugin.privacyPolicyUrl, undefined);
  assert.ok(existsSync(join(PLUGIN, plugin.skills, 'chrome-bridge', 'SKILL.md')));
  assert.ok(existsSync(join(PLUGIN, 'hooks', 'hooks.json')));
});

// Il server come lo avvia Claude Code, con stdin e stdout in pipe: initialize, poi tools/list.
function mcpToolNames(entry, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { env: { ...process.env, CHROME_BRIDGE_PORT: '0', ...env } });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`niente tools/list da ${entry}\n${err}`)); }, 120000);
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.stdin.end();
          resolve(msg.result.tools.map((x) => x.name));
        }
      }
    });
    child.once('exit', (code) => reject(new Error(`${entry} uscito con ${code}\n${err}`)));
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}

test('il bundle risponde in MCP con gli stessi tool di server/index.js', async () => {
  const [fromSource, fromBundle] = await Promise.all([
    mcpToolNames(join(ROOT, 'server', 'index.js')),
    mcpToolNames(join(PLUGIN, 'dist', 'index.js')),
  ]);
  assert.ok(fromSource.length > 30, `${fromSource.length} tool`);
  assert.deepEqual(fromBundle, fromSource);
});

test('la CLI incorporata elenca gli stessi tool, con le stesse definizioni', async () => {
  const run = (cli) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [cli, 'list-tools', '--format', 'json']);
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.once('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cli}: ${code}`))));
  });
  const [a, b] = await Promise.all([run(join(ROOT, 'server', 'cli.js')), run(join(PLUGIN, 'dist', 'cli.js'))]);
  assert.equal(b, a);
});

test('il plugin non avvia mai il launch mode, e non porta extension/', () => {
  const plugin = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  const srv = plugin.mcpServers['chrome-bridge'];
  assert.ok(!srv.args.includes('--launch'), JSON.stringify(srv.args));
  assert.equal(existsSync(join(PLUGIN, 'extension')), false);
  // Skill, comandi e hook non devono proporre --launch: dal plugin finirebbe nell'errore qui sotto.
  const texts = [...walk(PLUGIN)].map(([p]) => p).filter((p) => !p.startsWith('dist/') && /\.(md|json|sh|py)$/.test(p));
  const hits = texts.filter((p) => /--launch\b/.test(readFileSync(join(PLUGIN, p), 'utf8')));
  assert.deepEqual(hits, []);
});

test('lo stub di Lighthouse ha gli stessi export del modulo vero, e il bundle non lancia npx', async () => {
  const real = Object.keys(await import('../../server/lighthouse.js')).sort();
  const stub = Object.keys(await import('../../tools/plugin-stubs/lighthouse.js')).sort();
  assert.deepEqual(stub, real);
  const code = [...walk(join(PLUGIN, 'dist'))].map(([p]) => readFileSync(join(PLUGIN, 'dist', p), 'utf8')).join('\n');
  // I segni del modulo vero: la versione fissata da scaricare e il lanciatore di npx.
  assert.doesNotMatch(code, /lighthouse@\$\{/);
  assert.doesNotMatch(code, /npx-cli\.js/);
  assert.match(code, /Lighthouse is not part of the Claude Code plugin/);
});

test('--launch dal bundle senza extension/ esce con un errore che lo dice',
  { skip: process.platform === 'win32' && 'il browser finto è uno script sh' }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-plugin-launch-'));
    const fake = join(dir, 'browser.sh');
    await writeFile(fake, '#!/bin/sh\nexec sleep 600\n');
    await chmod(fake, 0o755);
    const child = spawn(process.execPath, [join(PLUGIN, 'dist', 'index.js'), '--launch'],
      { env: { ...process.env, CHROME_BRIDGE_BROWSER: fake, CHROME_BRIDGE_PORT: '', TMPDIR: dir } });
    let log = '';
    t.after(async () => { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); });
    child.stderr.on('data', (d) => { log += d; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ancora vivo dopo 60 s\n${log}`)), 60000);
      child.once('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 1, log);
    assert.match(log, /--launch needs the extension folder next to the server/);
    assert.match(log, /The Claude Code plugin does not ship it/);
    assert.doesNotMatch(log, /ENOENT/);
    // Nessun profilo temporaneo lasciato: il controllo viene prima di mkdtemp.
    assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith('chrome-bridge-launch-')), []);
  });
