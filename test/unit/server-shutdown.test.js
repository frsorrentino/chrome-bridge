import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'index.js');

// Il server come lo avvia Claude Code: stdin, stdout e stderr in pipe.
function startServer(args, env) {
  const child = spawn(process.execPath, [SERVER, ...args], { env: { ...process.env, ...env } });
  let log = '';
  const ready = new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => { log += d; if (log.includes('MCP server ready')) resolve(); });
    child.once('exit', (code) => reject(new Error(`uscito con ${code} prima di essere pronto:\n${log}`)));
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return { child, ready, exited, log: () => log };
}

// Un server che non esce fa fallire il test invece di bloccarlo. Scadenze
// larghe: a carico 30 e con nice 19 l'avvio in --launch ha superato i 60 s.
function within(promise, ms, what, log) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: niente dopo ${ms} ms\n${log()}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Su Windows Claude Code chiude stdin e dopo 300 ms uccide l'albero dei
// processi (2.1.296): SIGINT e SIGTERM non arrivano. Fino alla 1.30.2 la fine
// di stdin non era ascoltata e il WebSocket teneva vivo il server.
test('shutdown: la fine di stdin chiude il server', async (t) => {
  const s = startServer([], { CHROME_BRIDGE_PORT: '0' });
  t.after(() => s.child.kill('SIGKILL'));
  await within(s.ready, 120000, 'avvio', s.log);
  s.child.stdin.end();
  assert.equal(await within(s.exited, 60000, 'uscita dopo la fine di stdin', s.log), 0);
  assert.match(s.log(), /Shutting down/);
});

test('shutdown --launch: la fine di stdin ferma il browser e toglie il profilo temporaneo',
  { skip: process.platform === 'win32' && 'il browser finto è uno script sh' }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-shutdown-'));
    const fake = join(dir, 'browser.sh');
    await writeFile(fake, '#!/bin/sh\nexec sleep 600\n');
    await chmod(fake, 0o755);
    // TMPDIR: profilo temporaneo e spazzata del launcher restano dentro dir.
    const s = startServer(['--launch'], { CHROME_BRIDGE_BROWSER: fake, CHROME_BRIDGE_PORT: '', TMPDIR: dir });
    let pid;
    t.after(async () => {
      s.child.kill('SIGKILL');
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* già fermo */ } }
      await rm(dir, { recursive: true, force: true });
    });
    await within(s.ready, 120000, 'avvio', s.log);
    pid = Number(/ pid=(\d+)/.exec(s.log())[1]);
    s.child.stdin.end();
    assert.equal(await within(s.exited, 60000, 'uscita dopo la fine di stdin', s.log), 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'browser ancora vivo');
    assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith('chrome-bridge-launch-')), []);
  });

// Il client MCP muore durante l'avvio in --launch (28/10/2026: un server
// orfano da 2 h al 46% di CPU, con padre systemd e senza browser). Il padre
// intermedio avvia il server e si uccide con SIGKILL appena lo ha lanciato.
// stderr in pipe: il primo console.error dopo la morte del padre dava EPIPE,
// il gestore di uncaughtException riscriveva su stderr e il ciclo di errori
// non lasciava girare l'event loop, neanche per SIGTERM. stderr su file e
// stdin tenuto aperto da un altro processo: niente EOF, resta solo il cambio
// di padre.
async function orphanServer(t, { stderrToFile }) {
  const dir = await mkdtemp(join(tmpdir(), 'cb-orphan-'));
  const fake = join(dir, 'browser.sh');
  await writeFile(fake, `#!/bin/sh\necho $$ > '${join(dir, 'browser.pid')}'\nexec sleep 600\n`);
  await chmod(fake, 0o755);
  const errLog = join(dir, 'server.log');
  const parent = `
    const { spawn } = require('node:child_process');
    const { openSync } = require('node:fs');
    const err = ${stderrToFile} ? openSync(${JSON.stringify(errLog)}, 'w') : 'pipe';
    // Il lato di scrittura dello stdin del server lo tiene un sleep che
    // sopravvive al padre: nessun EOF arriva.
    const holder = ${stderrToFile} ? spawn('sleep', ['600'], { stdio: ['ignore', 'pipe', 'ignore'] }) : null;
    const c = spawn(process.execPath, [${JSON.stringify(SERVER)}, '--launch'], {
      stdio: [holder ? holder.stdout : 'pipe', 'pipe', err],
      env: { ...process.env, CHROME_BRIDGE_BROWSER: ${JSON.stringify(fake)}, CHROME_BRIDGE_PORT: '', TMPDIR: ${JSON.stringify(dir)} },
    });
    const die = () => process.stdout.write(c.pid + ' ' + (holder ? holder.pid : 0) + '\\n', () => process.kill(process.pid, 'SIGKILL'));
    // Con stdin aperto il server può accorgersi solo del cambio di padre, e
    // deve aver letto il padre vivo: si muore quando il WebSocket è su.
    if (!holder) die();
    else setInterval(() => { if (require('node:fs').readFileSync(${JSON.stringify(errLog)}, 'utf8').includes('listening')) die(); }, 50);
  `;
  const p = spawn(process.execPath, ['-e', parent], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  await new Promise((resolve) => p.once('exit', resolve));
  const [pid, holder] = out.trim().split(' ').map(Number);
  assert.ok(pid > 0, `pid del server non letto: ${out}`);
  t.after(async () => {
    const browser = Number(await readFile(join(dir, 'browser.pid'), 'utf8').catch(() => 0));
    for (const q of [pid, holder, browser]) { if (q) { try { process.kill(q, 'SIGKILL'); } catch { /* già fermo */ } } }
    await rm(dir, { recursive: true, force: true });
  });
  return { pid, dir };
}

async function waitGone(pid, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test('launch_exits_without_client: il padre muore durante l\'avvio e stderr si rompe',
  { skip: process.platform === 'win32' && 'il browser finto è uno script sh' }, async (t) => {
    const s = await orphanServer(t, { stderrToFile: false });
    assert.ok(await waitGone(s.pid, 60000), `server ${s.pid} ancora vivo 60 s dopo la morte del padre`);
  });

test('launch_exits_without_client: il padre muore e stdin resta aperto',
  { skip: process.platform === 'win32' && 'il browser finto è uno script sh' }, async (t) => {
    const s = await orphanServer(t, { stderrToFile: true });
    assert.ok(await waitGone(s.pid, 60000), `server ${s.pid} ancora vivo 60 s dopo la morte del padre`);
    assert.deepEqual((await readdir(s.dir)).filter((n) => n.startsWith('chrome-bridge-launch-')), [], 'profilo temporaneo rimasto');
  });
