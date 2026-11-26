/**
 * plugin/ è la cartella che Claude Code installa (marketplace.json: source "./plugin").
 * Dentro c'è solo ciò che gira: il server incorporato in dist/ (niente npx, niente
 * download da npm) e le copie di skills/ commands/ hooks/ observe/ extension/.
 * Questi test falliscono se plugin/ non è stato rigenerato dopo un cambio, se esce dai
 * limiti della directory (512 file, 256 KiB a file, niente link) o se il bundle non
 * risponde come server/index.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  assert.ok(existsSync(join(PLUGIN, plugin.icon)), `icona ${plugin.icon}`);
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

test('--launch dal bundle copia plugin/extension nel profilo e la carica',
  { skip: process.platform === 'win32' && 'il browser finto è uno script sh' }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-plugin-launch-'));
    const fake = join(dir, 'browser.sh');
    const argsFile = join(dir, 'args.txt');
    // Il browser finto scrive gli argomenti e controlla subito la copia dell'estensione.
    await writeFile(fake, `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "${argsFile}"\nexec sleep 600\n`);
    await chmod(fake, 0o755);
    const child = spawn(process.execPath, [join(PLUGIN, 'dist', 'index.js'), '--launch'],
      { env: { ...process.env, CHROME_BRIDGE_BROWSER: fake, CHROME_BRIDGE_PORT: '', TMPDIR: dir } });
    let log = '';
    t.after(async () => {
      child.kill('SIGKILL');
      const pid = / pid=(\d+)/.exec(log)?.[1];
      if (pid) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* già fermo */ } }
      await rm(dir, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`avvio --launch: niente dopo 120 s\n${log}`)), 120000);
      child.stderr.on('data', (d) => { log += d; if (log.includes('MCP server ready')) { clearTimeout(timer); resolve(); } });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`uscito con ${code}\n${log}`)); });
    });
    const args = (await readFile(argsFile, 'utf8')).split('\n');
    const ext = args.find((a) => a.startsWith('--load-extension='))?.slice('--load-extension='.length);
    assert.ok(ext, `nessun --load-extension in ${args.join(' ')}`);
    const manifest = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
    const ours = JSON.parse(readFileSync(join(PLUGIN, 'extension', 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, ours.version);
  });
