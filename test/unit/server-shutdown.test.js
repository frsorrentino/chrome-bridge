import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
