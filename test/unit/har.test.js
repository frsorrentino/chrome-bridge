import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHar } from '../../server/har.js';

test('converte richieste in HAR 1.2', () => {
  const har = toHar([
    { type: 'fetch', method: 'GET', url: 'https://x.test/a', startTime: 1700000000000, status: 200, duration: 123 },
    { type: 'xhr', method: 'POST', url: 'https://x.test/b', startTime: 1700000001000, status: null, duration: null, error: 'Network error' },
  ]);
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.entries.length, 2);
  assert.equal(har.log.entries[0].request.method, 'GET');
  assert.equal(har.log.entries[0].response.status, 200);
  assert.equal(har.log.entries[0].time, 123);
  assert.equal(har.log.entries[1].response.status, 0);
});
