/**
 * Un comando lungo (handoff fino a 10 minuti) passato da un relay finiva nel
 * service worker e la risposta veniva scartata dal primary allo sweep fisso
 * dei 150 s: il chiamante aspettava il timeout di trasporto senza saperlo.
 * La scadenza dell'attesa deve seguire il comando.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayExpiry } from '../../server/ws-manager.js';
import { MessageType, PENDING_RELAY_TTL_MS, getTimeout } from '../../server/protocol.js';

test('un comando breve mantiene il TTL storico', () => {
  assert.equal(relayExpiry({ type: MessageType.CLICK, params: {} }), PENDING_RELAY_TTL_MS + 5000);
});

test('handoff dura quanto il suo timeout di trasporto', () => {
  assert.equal(relayExpiry({ type: MessageType.HANDOFF, params: {} }), getTimeout(MessageType.HANDOFF) + 5000);
  assert.ok(relayExpiry({ type: MessageType.HANDOFF, params: {} }) >= 600000);
});

test('un timeout chiesto più lungo di quello di tipo vince', () => {
  assert.equal(relayExpiry({ type: MessageType.WAIT_FOR_ELEMENT, params: { timeout: 900000 } }), 900000 + 10000);
});
