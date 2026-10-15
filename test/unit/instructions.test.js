import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTIONS, RULES } from '../../server/instructions.js';

// Claude Code taglia le istruzioni del server a 4.096 caratteri dalla 2.1.296,
// a 2.048 fino alla 2.1.295.
const LIMIT = 4096;
const LEGACY_LIMIT = 2048;

test('istruzioni: arrivano intere a Claude Code 2.1.296 e successivi', () => {
  assert.ok(INSTRUCTIONS.length <= LIMIT, `${INSTRUCTIONS.length} caratteri, il limite è ${LIMIT}`);
});

test('istruzioni: ogni regola di RULES arriva intera anche a Claude Code 2.1.295', () => {
  const received = INSTRUCTIONS.slice(0, LEGACY_LIMIT);
  for (const rule of RULES) assert.ok(received.includes(rule), `tagliata: ${rule.slice(0, 60)}…`);
});

// Fino alla 1.30.2 un client vecchio perdeva la coda della regola sui
// download e tutta quella sulle schede nascoste, aggiunte per ultime.
test('istruzioni: download, schede nascoste e altro browser arrivano interi a Claude Code 2.1.295', () => {
  const received = INSTRUCTIONS.slice(0, LEGACY_LIMIT);
  for (const end of [
    'do not switch to chrome-bridge on your own.',
    'capture_downloads arm, then click, then capture_downloads wait.',
    'or create_tab new_window with bounds.',
  ]) assert.ok(received.includes(end), `tagliata: …${end}`);
});
