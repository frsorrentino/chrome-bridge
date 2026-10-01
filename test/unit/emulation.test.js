/**
 * emulate_media via debugger: le opzioni diventano i comandi CDP giusti, in
 * un solo setEmulatedMedia per tutte le preferenze.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emulationCommands, NETWORK_PROFILES } from '../../extension/lib/emulation.js';

test('preferenze in un solo setEmulatedMedia, stampa compresa', () => {
  const { commands, emulated } = emulationCommands({ reducedMotion: 'reduce', colorScheme: 'dark', contrast: 'more', printMode: true });
  assert.equal(commands.length, 1);
  const [method, params] = commands[0];
  assert.equal(method, 'Emulation.setEmulatedMedia');
  assert.equal(params.media, 'print');
  assert.deepEqual(params.features.map((f) => f.name), ['prefers-color-scheme', 'prefers-reduced-motion', 'prefers-contrast']);
  assert.deepEqual(emulated, { colorScheme: 'dark', reducedMotion: 'reduce', contrast: 'more', printMode: true });
});

test('CPU, rete, dispositivo e touch', () => {
  const { commands, emulated } = emulationCommands({ cpu_throttle: 4, network: 'slow-4g', device: { width: 390, height: 844, dpr: 3, mobile: true }, touch: true });
  assert.deepEqual(commands.map(([m]) => m), [
    'Emulation.setCPUThrottlingRate', 'Network.emulateNetworkConditions', 'Emulation.setDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled',
  ]);
  assert.deepEqual(commands[1][1], NETWORK_PROFILES['slow-4g']);
  assert.deepEqual(commands[2][1], { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  assert.equal(emulated.cpu_throttle, 4);
});

test('rallentamento sotto 1 portato a 1; profilo e dispositivo sbagliati rifiutati', () => {
  assert.equal(emulationCommands({ cpu_throttle: 0.5 }).commands[0][1].rate, 1);
  assert.throws(() => emulationCommands({ network: '5g' }), /Unknown network profile 5g/);
  assert.throws(() => emulationCommands({ device: { width: 0 } }), /width and height/);
});

test('niente opzioni, niente comandi', () => {
  assert.deepEqual(emulationCommands({}), { commands: [], emulated: {} });
});
