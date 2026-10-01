/**
 * Launch mode: avvia un browser Chromium dedicato (headless o no) con
 * profilo effimero e l'estensione caricata unpacked da una copia temporanea.
 *
 * La copia contiene un launch.json con la porta WS del server: nel pacchetto
 * Chrome Web Store il file non esiste e l'estensione usa la porta da storage.
 * Profilo e copia vengono rimossi allo stop.
 */

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

/**
 * Percorsi standard per piattaforma. Chromium, Edge e Brave prima di Google
 * Chrome: il Chrome brandizzato dalla 137 ignora --load-extension, parte ma
 * l'estensione non si connette mai (test Windows del 27/09: Chrome 155 muto,
 * Edge 154 connesso in meno di 6 s).
 */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const bases = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean);
    return [
      ['Chromium', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
    ].flatMap((parts) => bases.map((b) => win32.join(b, ...parts)));
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
  }
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
}

/** Google Chrome brandizzato (non Chromium, non Chrome for Testing). */
export function isBrandedChrome(path) {
  return /google[\\/ _-]?chrome/i.test(path) && !/for[ _-]?testing/i.test(path);
}

export const BRANDED_CHROME_HINT = 'Google Chrome 137+ ignores --load-extension, so launch mode cannot load the extension into it:'
  + ' set CHROME_BRIDGE_BROWSER to Chromium, Microsoft Edge, Brave or Chrome for Testing';

export function findBrowser() {
  if (process.env.CHROME_BRIDGE_BROWSER) {
    if (!existsSync(process.env.CHROME_BRIDGE_BROWSER)) {
      throw new Error(`CHROME_BRIDGE_BROWSER not found: ${process.env.CHROME_BRIDGE_BROWSER}`);
    }
    return process.env.CHROME_BRIDGE_BROWSER;
  }
  const candidates = browserCandidates();
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`No Chromium-based browser found (tried: ${candidates.join(', ')}). Set CHROME_BRIDGE_BROWSER to Chromium, Edge, Brave or Chrome for Testing.`);
  }
  return found;
}

const LAUNCH_PREFIX = 'chrome-bridge-launch-';
const STALE_WITHOUT_OWNER_MS = 24 * 3600 * 1000;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Cartelle di sessioni launch finite male o mai pulite: su Windows Edge tiene
// i file del profilo anche dopo la chiusura, rm falliva in silenzio e restavano
// circa 47 MB a sessione (01-02/10/2026: 73 cartelle, 3,5 GB in %TEMP%). Ogni
// cartella dice di chi è (owner.json con il pid del server): si cancella se
// quel processo non esiste più. Senza owner.json (versioni fino alla 1.27) solo
// dopo 24 ore, per non toccare una sessione in corso.
export async function sweepStaleLaunchDirs({ dir = tmpdir(), now = Date.now(), alive = processAlive } = {}) {
  const removed = [];
  let names = [];
  try { names = await readdir(dir); } catch { return removed; }
  for (const name of names.filter((n) => n.startsWith(LAUNCH_PREFIX))) {
    const path = join(dir, name);
    let stale;
    try {
      const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
      stale = !alive(owner.pid);
    } catch {
      try { stale = now - (await stat(path)).mtimeMs > STALE_WITHOUT_OWNER_MS; } catch { stale = false; }
    }
    if (!stale) continue;
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed.push(name);
    } catch { /* ancora bloccata: ci riprova il prossimo avvio */ }
  }
  return removed;
}

/** Prepara dir temporanee: copia estensione + launch.json, profilo con dev mode. */
export async function prepareLaunch(port) {
  const base = await mkdtemp(join(tmpdir(), LAUNCH_PREFIX));
  await writeFile(join(base, 'owner.json'), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  const extDir = join(base, 'ext');
  const profileDir = join(base, 'profile');

  await cp(EXTENSION_SRC, extDir, { recursive: true });
  await writeFile(join(extDir, 'launch.json'), JSON.stringify({ port }));

  // Dev mode pre-abilitato: su Chrome 135-137 sblocca chrome.userScripts;
  // su versioni successive execute_js usa comunque il fallback new Function.
  await mkdir(join(profileDir, 'Default'), { recursive: true });
  await writeFile(join(profileDir, 'Default', 'Preferences'),
    JSON.stringify({ extensions: { ui: { developer_mode: true } } }));

  return { base, extDir, profileDir };
}

/**
 * Avvia il browser. Ritorna { pid, stop } — stop() termina il processo e
 * rimuove le directory temporanee.
 */
export async function launchBrowser({ port, headless = false }) {
  const browser = findBrowser();
  const swept = await sweepStaleLaunchDirs();
  if (swept.length) console.error(`[chrome-bridge] removed ${swept.length} leftover launch profile(s) from earlier sessions`);
  const { base, extDir, profileDir } = await prepareLaunch(port);

  const args = [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-gpu',
    '--window-size=1280,800',
    // Porta CDP su 127.0.0.1 per lighthouse e heap_snapshot, che
    // chrome.debugger non può dare (HeapProfiler rifiutato, Lighthouse vuole
    // un browser intero). Porta scelta dal sistema, letta da DevToolsActivePort.
    // Il profilo è temporaneo: la porta non espone i dati dell'utente.
    '--remote-debugging-port=0',
  ];
  if (headless) args.push('--headless=new');
  args.push('about:blank');

  const proc = spawn(browser, args, { stdio: 'ignore', detached: false });
  proc.on('error', (err) => console.error(`[chrome-bridge] browser process error: ${err.message}`));

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 3000);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    // Su Windows i processi figli del browser rilasciano i file qualche
    // istante dopo l'uscita del principale: ritentativi invece di un solo
    // tentativo silenzioso. Se non basta, la spazzata del prossimo avvio la
    // trova (owner.json con un pid morto).
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch((e) => {
      console.error(`[chrome-bridge] could not remove ${base} (${e.code ?? e.message}); the next launch removes it`);
    });
  };

  console.error(`[chrome-bridge] launched ${browser}${headless ? ' (headless)' : ''} pid=${proc.pid}, ws port ${port}`);
  const branded = isBrandedChrome(browser);
  if (branded) console.error(`[chrome-bridge] warning: ${BRANDED_CHROME_HINT}`);
  return { pid: proc.pid, stop, branded, cdpPort: () => readDevToolsPort(profileDir) };
}

/** Porta CDP del browser lanciato: Chrome la scrive in DevToolsActivePort appena è in ascolto. */
export async function readDevToolsPort(profileDir, { timeoutMs = 10000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const port = Number((await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      if (port > 0) return port;
    } catch { /* non ancora scritto */ }
    if (Date.now() > until) throw new Error('The launched browser did not open its DevTools port (DevToolsActivePort missing)');
    await new Promise((r) => setTimeout(r, 200));
  }
}
