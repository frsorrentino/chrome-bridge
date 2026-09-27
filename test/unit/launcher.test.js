import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { BRANDED_CHROME_HINT, browserCandidates, findBrowser, isBrandedChrome, prepareLaunch } from '../../server/launcher.js';
import { WSManager } from '../../server/ws-manager.js';

test('findBrowser: CHROME_BRIDGE_BROWSER inesistente erra chiaro', () => {
  process.env.CHROME_BRIDGE_BROWSER = '/nope/browser';
  try {
    assert.throws(() => findBrowser(), /CHROME_BRIDGE_BROWSER not found/);
  } finally {
    delete process.env.CHROME_BRIDGE_BROWSER;
  }
});

test('prepareLaunch: copia estensione con launch.json e profilo con dev mode', async () => {
  const { base, extDir, profileDir } = await prepareLaunch(40123);
  try {
    const launch = JSON.parse(await readFile(join(extDir, 'launch.json'), 'utf8'));
    assert.equal(launch.port, 40123);
    // La copia contiene l'estensione vera
    await access(join(extDir, 'manifest.json'));
    await access(join(extDir, 'service-worker.js'));
    const prefs = JSON.parse(await readFile(join(profileDir, 'Default', 'Preferences'), 'utf8'));
    assert.equal(prefs.extensions.ui.developer_mode, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// Test Windows del 27/09: l'elenco era solo Linux, e il Chrome brandizzato
// (137+) ignora --load-extension. Chromium, Edge e Brave vengono prima.
test('browserCandidates win32: percorsi standard, Chrome brandizzato per ultimo', () => {
  const c = browserCandidates('win32', {
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  });
  assert.equal(c.length, 12);
  assert.equal(c[0], 'C:\\Users\\u\\AppData\\Local\\Chromium\\Application\\chrome.exe');
  assert.ok(c.includes('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'));
  assert.ok(c.includes('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'));
  assert.ok(c.slice(-3).every(isBrandedChrome));
  assert.ok(!c.slice(0, -3).some(isBrandedChrome));
});

test('browserCandidates darwin e linux', () => {
  const mac = browserCandidates('darwin', {});
  assert.deepEqual(mac.map((p) => p.split('/')[2]), ['Chromium.app', 'Microsoft Edge.app', 'Brave Browser.app', 'Google Chrome.app']);
  assert.equal(browserCandidates('linux', {})[0], '/usr/bin/chromium');
});

test('isBrandedChrome: Google Chrome si, Chromium, Edge e Chrome for Testing no', () => {
  assert.ok(isBrandedChrome('/usr/bin/google-chrome-stable'));
  assert.ok(isBrandedChrome('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(!isBrandedChrome('/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
  assert.ok(!isBrandedChrome('C:\\Program Files\\Chromium\\Application\\chrome.exe'));
  assert.ok(!isBrandedChrome('/usr/bin/chromium'));
});

test('estensione non connessa dopo il lancio di Chrome brandizzato: l\'errore dice perche\'', async () => {
  const ws = new WSManager(0, { connectWait: 50 });
  ws.mode = 'primary';
  ws.notConnectedHint = BRANDED_CHROME_HINT;
  await assert.rejects(ws.sendCommand('get_tabs'), /ignores --load-extension.*CHROME_BRIDGE_BROWSER/);
});
