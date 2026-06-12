import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { checkLinksBatch } from '../../server/link-checker.js';

let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200); res.end('ok'); return; }
    if (req.url === '/missing') { res.writeHead(404); res.end(); return; }
    if (req.url === '/no-head') {
      if (req.method === 'HEAD') { res.writeHead(405); res.end(); return; }
      res.writeHead(200); res.end('ok'); return;
    }
    res.writeHead(500); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('rileva 200, 404 e fallback GET su HEAD 405', async () => {
  const results = await checkLinksBatch([
    { url: `${base}/ok`, text: 'ok' },
    { url: `${base}/missing`, text: 'missing' },
    { url: `${base}/no-head`, text: 'nohead' },
  ], 2000);
  assert.equal(results[0].broken, false);
  assert.equal(results[0].status, 200);
  assert.equal(results[1].broken, true);
  assert.equal(results[1].status, 404);
  assert.equal(results[2].broken, false);
  assert.equal(results[2].status, 200);
});

test('errore di rete → broken con error', async () => {
  const results = await checkLinksBatch([{ url: 'http://127.0.0.1:1/x', text: 'dead' }], 1000);
  assert.equal(results[0].broken, true);
  assert.ok(results[0].error);
});
