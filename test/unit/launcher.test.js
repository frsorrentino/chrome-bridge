import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { findBrowser, prepareLaunch } from '../../server/launcher.js';

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
