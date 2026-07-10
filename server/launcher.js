/**
 * Launch mode: avvia un browser Chromium dedicato (headless o no) con
 * profilo effimero e l'estensione caricata unpacked da una copia temporanea.
 *
 * La copia contiene un launch.json con la porta WS del server: nel pacchetto
 * Chrome Web Store il file non esiste e l'estensione usa la porta da storage.
 * Profilo e copia vengono rimossi allo stop.
 */

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSION_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

const BROWSER_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

export function findBrowser() {
  if (process.env.CHROME_BRIDGE_BROWSER) {
    if (!existsSync(process.env.CHROME_BRIDGE_BROWSER)) {
      throw new Error(`CHROME_BRIDGE_BROWSER not found: ${process.env.CHROME_BRIDGE_BROWSER}`);
    }
    return process.env.CHROME_BRIDGE_BROWSER;
  }
  const found = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`No Chromium/Chrome binary found (tried: ${BROWSER_CANDIDATES.join(', ')}). Set CHROME_BRIDGE_BROWSER.`);
  }
  return found;
}

/** Prepara dir temporanee: copia estensione + launch.json, profilo con dev mode. */
export async function prepareLaunch(port) {
  const base = await mkdtemp(join(tmpdir(), 'chrome-bridge-launch-'));
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
  const { base, extDir, profileDir } = await prepareLaunch(port);

  const args = [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-gpu',
    '--window-size=1280,800',
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
    await rm(base, { recursive: true, force: true }).catch(() => {});
  };

  console.error(`[chrome-bridge] launched ${browser}${headless ? ' (headless)' : ''} pid=${proc.pid}, ws port ${port}`);
  return { pid: proc.pid, stop };
}
