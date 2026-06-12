import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommand } from '../../server/protocol.js';

test('createCommand genera id univoci nello stesso processo; formato msg_<hex8>_<counter>', () => {
  const a = createCommand('navigate');
  const b = createCommand('navigate');
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^msg_[0-9a-f]{8}_\d+$/);
});
